#!/usr/bin/env python3
"""
Twilio phone-number integration in Python (search, purchase, list, balance)
Uses the official Twilio helper library (twilio-python 9.x).

Install: pip install "twilio>=9"
Run:     export TWILIO_ACCOUNT_SID=ACxxxx TWILIO_AUTH_TOKEN=xxxx
         python twilio_numbers.py          # search + list only (no charge)
         python twilio_numbers.py --buy    # also purchases the first number found
"""

import argparse
import os
import sys

from twilio.base.exceptions import TwilioRestException
from twilio.rest import Client


# ---- Phone-number helpers ---------------------------------------------------

def search_available(client: Client, country: str, number_type: str, **filters):
    """number_type: "Local", "TollFree" or "Mobile".

    filters use snake_case names, e.g. area_code=415, in_locality="San Francisco",
    sms_enabled=True, limit=5.
    """
    country_ctx = client.available_phone_numbers(country)
    readers = {
        "Local": country_ctx.local,
        "TollFree": country_ctx.toll_free,
        "Mobile": country_ctx.mobile,
    }
    if number_type not in readers:
        raise ValueError(f"Unknown number type: {number_type}")
    return readers[number_type].list(**filters)


def purchase(client: Client, phone_number: str, **options):
    return client.incoming_phone_numbers.create(phone_number=phone_number, **options)


def list_owned(client: Client, limit: int = 20):
    return client.incoming_phone_numbers.list(limit=limit)


def balance(client: Client):
    return client.balance.fetch()


# ---- Main -------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Twilio phone-number demo")
    parser.add_argument("--buy", action="store_true",
                        help="purchase the first number found (charges your account)")
    args = parser.parse_args()

    sid = os.environ.get("TWILIO_ACCOUNT_SID")
    token = os.environ.get("TWILIO_AUTH_TOKEN")
    if not sid or not token:
        print("Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables.",
              file=sys.stderr)
        return 1

    client = Client(sid, token)

    try:
        # 1. Check balance
        bal = balance(client)
        print(f"Account balance: {bal.balance} {bal.currency}")

        # 2. Search available US local numbers
        print("\nSearching for available numbers...")
        numbers = search_available(
            client, "US", "Local",
            area_code=415,        # optional
            sms_enabled=True,     # optional
            voice_enabled=True,   # optional
            limit=5,
        )
        # Other examples:
        #   search_available(client, "US", "Local",    in_locality="San Francisco")
        #   search_available(client, "US", "TollFree", limit=10)
        #   search_available(client, "US", "Mobile",   limit=10)

        print(f"Found {len(numbers)} available numbers:")
        for n in numbers:
            print(f"- {n.phone_number} (Locality: {n.locality or ''})")

        # 3. Purchase the first one (only with --buy, since this charges your account)
        if args.buy and numbers:
            selected = numbers[0].phone_number
            print(f"\nPurchasing {selected}...")

            purchased = purchase(
                client, selected,
                friendly_name="My First Twilio Number",
                # Optional configuration at purchase time:
                # sms_url="https://yourapp.com/sms",     sms_method="POST",
                # voice_url="https://yourapp.com/voice", voice_method="POST",
                # status_callback="https://yourapp.com/status",
            )

            print(f"Successfully purchased: {purchased.phone_number}")
            print(f"  SID: {purchased.sid}")
            print(f"  Friendly Name: {purchased.friendly_name}")
        elif not args.buy:
            print("\n(Dry run: pass --buy to purchase the first number.)")

        # 4. List numbers you own
        print("\nYour numbers:")
        for n in list_owned(client, 20):
            print(f"- {n.phone_number} - {n.friendly_name}")

    except TwilioRestException as e:
        print(f"Twilio error {e.code} (HTTP {e.status}): {e.msg}", file=sys.stderr)
        if e.code:
            print(f"More info: https://www.twilio.com/docs/errors/{e.code}", file=sys.stderr)
        # e.g. 20003 = authentication failed, 21422 = number not available
        return 2
    except Exception as e:  # network errors, bad config, etc.
        print(f"Error: {e}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())