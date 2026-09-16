// twilioToolStream.ts — default streaming for the SECOND LLM call
// (post-tool-dispatch) in tool-enabled assistant turns.
//
// The no-tools streaming path (tryStreamingTwilioReply) is gated to assistants
// with zero tools — everything else falls back to the buffered flow. That gate
// is too strict for the common "customer-support" shape: assistants whose
// tools are all knowledge-base, weather, calculator, etc. don't change TwiML
// flow after dispatch, so the second LLM call's reply is always plain spoken
// text that's safe to stream.
//
// This module widens the gate. When every configured tool is in
// STREAMABLE_TOOL_TYPES AND no marker-emitting flag is set, the webhook can
// return <Play>audio</Play><Gather> TwiML up-front, and callOpenAIWithTools
// streams the second LLM call's content sentence-by-sentence into the audio
// session as it lands in the SSE stream. The first LLM call stays
// non-streaming because tool_calls detection needs the full body.
//
// Two flow shapes are handled:
//   1. LLM dispatched a safe tool → second call streams content into the sink.
//   2. LLM produced a plain reply on the first call → callOpenAIWithTools
//      feeds that full content through the same sentence buffer.

import type { Request, Response } from 'express';
import type { Assistant } from '../repository';
import {
  appendCallTranscript,
  assistantModelCanUseTwilioOpenAIStream,
  buildTwilioGatherResponseVerbs,
  elevenLabsTTSModel,
  generateAssistantReplyWithHistory,
  parseAssistantTools,
  startSpeculativeKBSearch,
  startTTSStreamFromSentenceCh,
  twilioStreamLLMEnabled,
  writeTwiml,
  type AssistantCallConfig,
  type ChatMessage,
} from './twilio';

// ---------------------------------------------------------------------------
// Context + sink plumbing (Go context.Context / chan<- string equivalents)
// ---------------------------------------------------------------------------

/** Writable end of the TTS sentence pipeline (Go: chan<- string). */
export interface SentenceSink {
  /** Resolves once the sentence is accepted; rejects/never resolves if closed. */
  push(sentence: string): Promise<void>;
  close(): void;
}

/**
 * Minimal stand-in for Go's context.Context: an abort signal plus a bag of
 * request-scoped values. Callers derive children with {@link withLLMSentenceSink}.
 */
export interface CallContext {
  readonly signal: AbortSignal;
  readonly llmSentenceSink?: SentenceSink;
  readonly [key: string]: unknown;
}

/** Attaches the sentence sink to ctx. The sink is closed by the caller. */
export function withLLMSentenceSink(
  ctx: CallContext,
  sink: SentenceSink,
): CallContext {
  return { ...ctx, llmSentenceSink: sink };
}

/** Returns the attached sentence sink (or undefined). */
export function getLLMSentenceSink(ctx: CallContext): SentenceSink | undefined {
  return ctx.llmSentenceSink;
}

/**
 * Pushes one sentence into the sink with an abort guard so a hung TTS
 * session doesn't wedge the LLM task.
 */
export async function pushLLMSentence(
  ctx: CallContext,
  sink: SentenceSink | undefined,
  sentence: string,
): Promise<void> {
  if (!sink || sentence === '') return;
  if (ctx.signal.aborted) return;

  await Promise.race([
    sink.push(sentence),
    new Promise<void>((resolve) =>
      ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Tool types whose dispatch always produces a plain spoken text reply.
 * Tools that change TwiML flow (call_transfer, end_call, collect_dtmf) or
 * bypass the LLM via canned state machines (book_appointment, api_request)
 * are deliberately excluded.
 */
export const STREAMABLE_TOOL_TYPES: ReadonlySet<string> = new Set([
  'knowledge_base_query',
  'search_query',
  'get_weather',
  'calculate',
  'current_datetime',
  'caller_id_lookup',
  'save_note',
  'get_business_hours',
  'send_email_live',
  'send_sms_live',
  'check_availability',
]);

interface TechnicalConfig {
  call_forwarding?: boolean;
  dtmf_tones?: boolean;
  record_audio?: boolean;
  auto_deletion?: boolean;
}

function parseTechnicalConfig(raw: unknown): TechnicalConfig {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as TechnicalConfig;
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      return JSON.parse(raw) as TechnicalConfig;
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Gates the tool-streaming fast path. Streaming requires:
 *   - TWILIO_STREAM_LLM not explicitly disabled
 *   - a configured ElevenLabs voice
 *   - a model that supports the Twilio OpenAI stream
 *   - at least one tool (zero tools → tryStreamingTwilioReply handles it)
 *   - every configured tool in STREAMABLE_TOOL_TYPES
 *   - no marker-emitting flag (call_forwarding, dtmf_tones, record+auto_deletion)
 */
export function shouldUseToolStreamingLLM(
  assistant: Assistant | null | undefined,
): boolean {
  if (!twilioStreamLLMEnabled() || !assistant) return false;
  if ((assistant.voiceId ?? '').trim() === '') return false;
  if (!assistantModelCanUseTwilioOpenAIStream(assistant)) return false;

  const tools = parseAssistantTools(assistant.tools);
  if (tools.length === 0) return false;
  if (!tools.every((t) => STREAMABLE_TOOL_TYPES.has(t.type))) return false;

  const techCfg = parseTechnicalConfig(assistant.technicalConfig);
  if (techCfg.call_forwarding || techCfg.dtmf_tones) return false;
  if (techCfg.record_audio && techCfg.auto_deletion) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Fast path
// ---------------------------------------------------------------------------

const LLM_TIMEOUT_MS = 25_000;
const APOLOGY = 'I am sorry, I am having trouble responding right now.';

export interface ToolStreamingReplyArgs {
  assistant: Assistant;
  messages: ChatMessage[];
  callSID: string;
  phoneNumberID: number;
  speechInput: string;
  direction: string;
  callCfg: AssistantCallConfig;
  projectID: number;
}

/**
 * Runs the tool-streaming fast path for one turn.
 * Returns true on success (TwiML written; caller must return).
 * Returns false when streaming setup is not viable — `res` is untouched and
 * the caller continues with the existing non-streaming flow.
 */
export function tryToolStreamingReply(
  req: Request,
  res: Response,
  args: ToolStreamingReplyArgs,
): boolean {
  const {
    assistant,
    messages,
    callSID,
    speechInput,
    direction,
    callCfg,
    projectID,
  } = args;

  const tts = startTTSStreamFromSentenceCh(
    req,
    assistant.voiceId,
    callCfg.speakingRate,
    elevenLabsTTSModel(callCfg),
  );
  if (!tts) return false;
  const { playVerb, sentenceSink } = tts;

  // The LLM task outlives the webhook handler — it gets its own controller
  // rather than the request's abort signal. 25 s covers first call + tool
  // dispatch + second call.
  const llmController = new AbortController();
  const timeout = setTimeout(() => llmController.abort(), LLM_TIMEOUT_MS);
  const llmCtx: CallContext = { signal: llmController.signal };

  void (async () => {
    let specCancel: (() => void) | undefined;
    try {
      // Attach sink so callOpenAIWithTools can stream the second call into it.
      let ctx = withLLMSentenceSink(llmCtx, sentenceSink);

      // Speculative KB pre-fetch — when the assistant has kb_query, the search
      // fires in parallel and executeKBQueryTool reuses the cached result.
      const toolsConfig = parseAssistantTools(assistant.tools);
      const spec = startSpeculativeKBSearch(
        ctx,
        assistant,
        toolsConfig,
        speechInput,
        projectID,
      );
      ctx = spec.ctx;
      specCancel = spec.cancel;

      let fullText = '';
      try {
        ({ text: fullText } = await generateAssistantReplyWithHistory(
          ctx,
          assistant,
          messages,
          callSID,
        ));
      } catch (err) {
        console.error(
          `[twilio/tool-stream-llm] error (assistant=${assistant.id}):`,
          err,
        );
        // Push an apology so the caller doesn't hear silence.
        await pushLLMSentence(llmCtx, sentenceSink, APOLOGY);
        if (fullText === '') fullText = APOLOGY;
      }

      if (callSID !== '') {
        await appendCallTranscript(callSID, speechInput, fullText);
      }
    } finally {
      specCancel?.();
      sentenceSink.close();
      clearTimeout(timeout);
      llmController.abort();
    }
  })();

  const twiml = buildTwilioGatherResponseVerbs(
    req,
    playVerb,
    assistant.language,
    assistant.uuid,
    direction,
    callCfg,
  );
  console.log(
    `[twilio/tool-stream-llm] assistant=${assistant.id} streaming reply (tools enabled)`,
  );
  writeTwiml(res, twiml);
  return true;
}
