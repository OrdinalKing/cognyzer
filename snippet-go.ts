package handler

// twilio_tool_stream.go — default streaming for the SECOND LLM call
// (post-tool-dispatch) in tool-enabled assistant turns.
//
// The existing no-tools streaming path (tryStreamingTwilioReply) is gated to
// assistants with zero tools — anything else falls back to the buffered
// flow. That gate is too strict for the common "customer-support" shape:
// assistants whose tools are all knowledge-base, weather, calculator, etc.
// don't change TwiML flow after dispatch, so the second LLM call's reply is
// always plain spoken text that's safe to stream.
//
// This file widens the gate. When every configured tool is in
// streamableToolTypes AND no marker-emitting flag is set, the webhook can
// return <Play>audio</Play><Gather> TwiML up-front, and callOpenAIWithTools
// streams the second LLM call's content sentence-by-sentence into the audio
// session as it lands in the SSE stream. The first LLM call remains
// non-streaming because tool_calls detection needs the full body — but the
// SECOND call is where multi-sentence replies live, so that's where the
// streaming win compounds.
//
// Two flow shapes are handled:
//
//   1. LLM dispatched a safe tool → second call streams content into the
//      sink as it arrives.
//
//   2. LLM produced a plain reply on the first call (no tool dispatch) →
//      callOpenAIWithTools feeds that full content through the same sentence
//      buffer so the audio session still gets sentences (otherwise the
//      audio-stream endpoint would hold an open response with zero bytes).

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"ooda.ai/platform/api/internal/repository"
)

// llmSentenceChCtxKey is the unexported context-value key under which the
// caller (tryToolStreamingReply) attaches the TTS sentence channel.
// callOpenAIWithTools reads it to decide whether to stream.
type llmSentenceChCtxKey struct{}

// withLLMSentenceCh attaches the sentence channel to ctx. The channel must
// be writable from the LLM goroutine and is closed by the caller.
func withLLMSentenceCh(ctx context.Context, ch chan<- string) context.Context {
	return context.WithValue(ctx, llmSentenceChCtxKey{}, ch)
}

// getLLMSentenceCh returns the attached sentence channel (or nil).
func getLLMSentenceCh(ctx context.Context) chan<- string {
	v, _ := ctx.Value(llmSentenceChCtxKey{}).(chan<- string)
	return v
}

// pushLLMSentence pushes one sentence into the sink with a ctx-cancel
// guard so a hung TTS session doesn't deadlock the LLM goroutine.
func pushLLMSentence(ctx context.Context, sink chan<- string, sentence string) {
	if sink == nil || sentence == "" {
		return
	}
	select {
	case sink <- sentence:
	case <-ctx.Done():
	}
}

// streamableToolTypes lists tool types whose dispatch always produces a
// plain spoken text reply (i.e. the second LLM call). Tools that change
// TwiML flow (call_transfer, end_call, collect_dtmf) or that bypass the
// LLM via canned state machines (book_appointment, api_request) are NOT
// in this set — those flows need the existing buffered path to inspect
// the full reply before committing TwiML.
var streamableToolTypes = map[string]bool{
	"knowledge_base_query": true,
	"search_query":         true,
	"get_weather":          true,
	"calculate":            true,
	"current_datetime":     true,
	"caller_id_lookup":     true,
	"save_note":            true,
	"get_business_hours":   true,
	"send_email_live":      true,
	"send_sms_live":        true,
	"check_availability":   true,
}

// shouldUseToolStreamingLLM gates the tool-streaming fast path. Streaming
// requires:
//   - TWILIO_STREAM_LLM not explicitly disabled (shared with the no-tools path)
//   - a configured ElevenLabs voice
//   - at least one tool (otherwise tryStreamingTwilioReply handles it)
//   - every configured tool in streamableToolTypes
//   - no marker-emitting flag (call_forwarding, dtmf_tones, record+auto-
//     deletion combo — all three inject text patterns the runtime parses
//     post-LLM, so the full reply must be inspected before TwiML lands)
func shouldUseToolStreamingLLM(assistant *repository.Assistant) bool {
	if !twilioStreamLLMEnabled() || assistant == nil {
		return false
	}
	if strings.TrimSpace(assistant.VoiceID) == "" {
		return false
	}
	if !assistantModelCanUseTwilioOpenAIStream(assistant) {
		return false
	}
	tools := parseAssistantTools(assistant.Tools)
	if len(tools) == 0 {
		// no-tools path (tryStreamingTwilioReply) handles this case
		return false
	}
	for _, t := range tools {
		if !streamableToolTypes[t.Type] {
			return false
		}
	}
	var techCfg struct {
		CallForwarding bool `json:"call_forwarding"`
		DTMFTones      bool `json:"dtmf_tones"`
		RecordAudio    bool `json:"record_audio"`
		AutoDeletion   bool `json:"auto_deletion"`
	}
	if len(assistant.TechnicalConfig) > 0 {
		_ = json.Unmarshal(assistant.TechnicalConfig, &techCfg)
	}
	if techCfg.CallForwarding || techCfg.DTMFTones {
		return false
	}
	if techCfg.RecordAudio && techCfg.AutoDeletion {
		return false
	}
	return true
}

// tryToolStreamingReply runs the tool-streaming fast path for one turn.
// Returns true on success (TwiML written, caller must return). Returns
// false when streaming setup is not viable; caller continues with the
// existing non-streaming flow — w has not been written to.
func tryToolStreamingReply(
	w http.ResponseWriter,
	r *http.Request,
	assistant *repository.Assistant,
	messages []map[string]string,
	callSID string,
	phoneNumberID int,
	speechInput, direction string,
	callCfg assistantCallConfig,
	projectID int,
) bool {
	playVerb, sentenceCh, ok := startTTSStreamFromSentenceCh(r, assistant.VoiceID, callCfg.SpeakingRate, elevenLabsTTSModel(callCfg))
	if !ok {
		return false
	}

	// LLM goroutine outlives the webhook handler — detach from r.Context().
	// Generous 25 s ceiling matches the longest realistic provider reply
	// chain (first call + tool dispatch + second call).
	llmCtx, llmCancel := context.WithTimeout(context.Background(), 25*time.Second)

	go func() {
		defer llmCancel()
		defer close(sentenceCh)

		// Attach sink to ctx so callOpenAIWithTools can stream the second
		// LLM call into it.
		ctxWithSink := withLLMSentenceCh(llmCtx, sentenceCh)

		// Compose with speculative KB pre-fetch — when the assistant has
		// kb_query, the search fires in parallel and executeKBQueryTool
		// skips its live search via the cached ctx value.
		toolsConfig := parseAssistantTools(assistant.Tools)
		ctxWithSink, specState := startSpeculativeKBSearch(ctxWithSink, assistant, toolsConfig, speechInput, projectID)
		defer specState.Cancel()

		fullText, _, err := generateAssistantReplyWithHistory(ctxWithSink, assistant, messages, callSID)
		if err != nil {
			log.Printf("[twilio/tool-stream-llm] error (assistant=%d): %v", assistant.ID, err)
			// Push an apology so the caller doesn't hear silence.
			pushLLMSentence(llmCtx, sentenceCh, "I am sorry, I am having trouble responding right now.")
			if fullText == "" {
				fullText = "I am sorry, I am having trouble responding right now."
			}
		}

		if callSID != "" {
			appendCallTranscript(context.Background(), callSID, speechInput, fullText)
		}
	}()

	twiml := buildTwilioGatherResponseVerbs(r, playVerb, assistant.Language,
		assistant.UUID, direction, callCfg)
	log.Printf("[twilio/tool-stream-llm] assistant=%d streaming reply (tools enabled)", assistant.ID)
	writeTwiml(w, twiml)
	return true
}
