// Twilio phone-number integration in Java (search, purchase, list, balance)
// Uses the official Twilio helper library (twilio-java 13.x), Java 8+.
//
// Maven:   <dependency>
//            <groupId>com.twilio.sdk</groupId>
//            <artifactId>twilio</artifactId>
//            <version>13.0.1</version>
//          </dependency>
// Gradle:  implementation "com.twilio.sdk:twilio:13.0.1"
//
// Run:     export TWILIO_ACCOUNT_SID=ACxxxx TWILIO_AUTH_TOKEN=xxxx
//          java TwilioNumbers           # search + list only (no charge)
//          java TwilioNumbers --buy     # also purchases the first number found

import com.twilio.Twilio;
import com.twilio.base.ResourceSet;
import com.twilio.exception.ApiException;
import com.twilio.rest.api.v2010.account.Balance;
import com.twilio.rest.api.v2010.account.IncomingPhoneNumber;
import com.twilio.rest.api.v2010.account.availablephonenumbercountry.Local;
import com.twilio.rest.api.v2010.account.availablephonenumbercountry.Mobile;
import com.twilio.rest.api.v2010.account.availablephonenumbercountry.TollFree;
import com.twilio.type.PhoneNumber;

import java.util.ArrayList;
import java.util.List;

public class TwilioNumbers {

    // ---- Phone-number helpers ----------------------------------------------

    /** Local numbers; add setInLocality(...), setContains(...) etc. as needed. */
    static List<Local> searchLocal(String country, Integer areaCode, int limit) {
        ResourceSet<Local> results = Local.reader(country)
                .setAreaCode(areaCode)      // optional (null = any)
                .setSmsEnabled(true)        // optional
                .setVoiceEnabled(true)      // optional
                .limit(limit)
                .read();
        List<Local> out = new ArrayList<>();
        results.forEach(out::add);
        return out;
    }

    static List<TollFree> searchTollFree(String country, int limit) {
        List<TollFree> out = new ArrayList<>();
        TollFree.reader(country).limit(limit).read().forEach(out::add);
        return out;
    }

    static List<Mobile> searchMobile(String country, int limit) {
        List<Mobile> out = new ArrayList<>();
        Mobile.reader(country).limit(limit).read().forEach(out::add);
        return out;
    }

    static IncomingPhoneNumber purchase(PhoneNumber number, String friendlyName) {
        return IncomingPhoneNumber.creator(number)
                .setFriendlyName(friendlyName)
                // Optional configuration at purchase time:
                // .setSmsUrl("https://yourapp.com/sms").setSmsMethod(HttpMethod.POST)
                // .setVoiceUrl("https://yourapp.com/voice").setVoiceMethod(HttpMethod.POST)
                // .setStatusCallback("https://yourapp.com/status")
                .create();
    }

    static ResourceSet<IncomingPhoneNumber> listOwned(int limit) {
        return IncomingPhoneNumber.reader().limit(limit).read();
    }

    static Balance balance() {
        return Balance.fetcher().fetch();
    }

    // ---- Main --------------------------------------------------------------

    public static void main(String[] args) {
        String sid = System.getenv("TWILIO_ACCOUNT_SID");
        String token = System.getenv("TWILIO_AUTH_TOKEN");
        if (sid == null || token == null) {
            System.err.println("Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables.");
            System.exit(1);
        }
        boolean buy = args.length > 0 && args[0].equals("--buy");

        Twilio.init(sid, token);
        int exitCode = 0;

        try {
            // 1. Check balance
            Balance bal = balance();
            System.out.println("Account balance: " + bal.getBalance() + " " + bal.getCurrency());

            // 2. Search available US local numbers
            System.out.println("\nSearching for available numbers...");
            List<Local> numbers = searchLocal("US", 415, 5);
            // Other examples:
            //   Local.reader("US").setInLocality("San Francisco").read();
            //   searchTollFree("US", 10);
            //   searchMobile("US", 10);

            System.out.println("Found " + numbers.size() + " available numbers:");
            for (Local n : numbers) {
                String locality = n.getLocality() != null ? n.getLocality() : "";
                System.out.println("- " + n.getPhoneNumber() + " (Locality: " + locality + ")");
            }

            // 3. Purchase the first one (only with --buy, since this charges your account)
            if (buy && !numbers.isEmpty()) {
                PhoneNumber selected = numbers.get(0).getPhoneNumber();
                System.out.println("\nPurchasing " + selected + "...");

                IncomingPhoneNumber purchased = purchase(selected, "My First Twilio Number");

                System.out.println("Successfully purchased: " + purchased.getPhoneNumber());
                System.out.println("  SID: " + purchased.getSid());
                System.out.println("  Friendly Name: " + purchased.getFriendlyName());
            } else if (!buy) {
                System.out.println("\n(Dry run: pass --buy to purchase the first number.)");
            }

            // 4. List numbers you own
            System.out.println("\nYour numbers:");
            for (IncomingPhoneNumber n : listOwned(20)) {
                System.out.println("- " + n.getPhoneNumber() + " - " + n.getFriendlyName());
            }

        } catch (ApiException e) {
            System.err.println("Twilio error " + e.getCode() + " (HTTP " + e.getStatusCode() + "): "
                    + e.getMessage());
            if (e.getMoreInfo() != null) System.err.println("More info: " + e.getMoreInfo());
            // e.g. 20003 = authentication failed, 21422 = number not available
            exitCode = 2;
        } catch (Exception e) {  // ApiConnectionException (network), bad config, etc.
            System.err.println("Error: " + e.getMessage());
            exitCode = 1;
        } finally {
            Twilio.destroy();
        }

        System.exit(exitCode);
    }
}