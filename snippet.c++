// Twilio phone-number integration in C++ (search, purchase, list, balance)
// Twilio has no official C++ SDK, so this talks to the REST API directly.
//
// Dependencies: libcurl, nlohmann/json (header-only), C++17
// Build:  g++ -std=c++17 twilio_numbers.cpp -lcurl -o twilio_numbers
// Run:    export TWILIO_ACCOUNT_SID=ACxxxx TWILIO_AUTH_TOKEN=xxxx
//         ./twilio_numbers          # search + list only (no charge)
//         ./twilio_numbers --buy    # also purchases the first number found

#include <curl/curl.h>
#include <nlohmann/json.hpp>

#include <cstdlib>
#include <cstring>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>

using json = nlohmann::json;
using Params = std::map<std::string, std::string>;

// Error returned by the Twilio API (HTTP 4xx/5xx)
struct TwilioError : std::runtime_error {
    long status;
    int code;
    std::string more_info;
    TwilioError(long s, int c, const std::string& msg, std::string info)
        : std::runtime_error(msg), status(s), code(c), more_info(std::move(info)) {}
};

// Safe string read: returns "" when the key is missing or null
static std::string str(const json& j, const char* key) {
    auto it = j.find(key);
    return (it != j.end() && it->is_string()) ? it->get<std::string>() : "";
}

class TwilioClient {
public:
    TwilioClient(std::string account_sid, std::string auth_token)
        : sid_(std::move(account_sid)), token_(std::move(auth_token)), curl_(curl_easy_init()) {
        if (!curl_) throw std::runtime_error("curl_easy_init failed");
    }
    ~TwilioClient() { curl_easy_cleanup(curl_); }
    TwilioClient(const TwilioClient&) = delete;
    TwilioClient& operator=(const TwilioClient&) = delete;

    const std::string& account_sid() const { return sid_; }

    json get(const std::string& path, const Params& query = {}) {
        std::string url = base_url() + path;
        if (!query.empty()) url += "?" + encode(query);
        return request(url, nullptr);
    }

    json post(const std::string& path, const Params& form) {
        const std::string body = encode(form);
        return request(base_url() + path, &body);
    }

    // ---- Phone-number helpers ------------------------------------------

    // type: "Local", "TollFree" or "Mobile"
    json search_available(const std::string& country, const std::string& type,
                          const Params& filters) {
        json r = get("/AvailablePhoneNumbers/" + country + "/" + type + ".json", filters);
        return r.value("available_phone_numbers", json::array());
    }

    json purchase(const Params& options) {  // must include "PhoneNumber"
        return post("/IncomingPhoneNumbers.json", options);
    }

    json list_owned(int page_size = 20) {
        json r = get("/IncomingPhoneNumbers.json", {{"PageSize", std::to_string(page_size)}});
        return r.value("incoming_phone_numbers", json::array());
    }

    json balance() { return get("/Balance.json"); }

private:
    std::string sid_, token_;
    CURL* curl_;

    std::string base_url() const {
        return "https://api.twilio.com/2010-04-01/Accounts/" + sid_;
    }

    std::string encode(const Params& params) {
        std::string out;
        for (const auto& [k, v] : params) {
            char* ek = curl_easy_escape(curl_, k.c_str(), static_cast<int>(k.size()));
            char* ev = curl_easy_escape(curl_, v.c_str(), static_cast<int>(v.size()));
            if (!out.empty()) out += '&';
            out += std::string(ek) + "=" + ev;
            curl_free(ek);
            curl_free(ev);
        }
        return out;
    }

    static size_t write_cb(char* ptr, size_t size, size_t nmemb, void* userdata) {
        static_cast<std::string*>(userdata)->append(ptr, size * nmemb);
        return size * nmemb;
    }

    json request(const std::string& url, const std::string* body) {
        curl_easy_reset(curl_);
        std::string response;

        curl_easy_setopt(curl_, CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl_, CURLOPT_HTTPAUTH, CURLAUTH_BASIC);
        curl_easy_setopt(curl_, CURLOPT_USERNAME, sid_.c_str());
        curl_easy_setopt(curl_, CURLOPT_PASSWORD, token_.c_str());
        curl_easy_setopt(curl_, CURLOPT_WRITEFUNCTION, &TwilioClient::write_cb);
        curl_easy_setopt(curl_, CURLOPT_WRITEDATA, &response);
        curl_easy_setopt(curl_, CURLOPT_TIMEOUT, 30L);
        if (body) {  // application/x-www-form-urlencoded POST
            curl_easy_setopt(curl_, CURLOPT_POST, 1L);
            curl_easy_setopt(curl_, CURLOPT_POSTFIELDS, body->c_str());
            curl_easy_setopt(curl_, CURLOPT_POSTFIELDSIZE, static_cast<long>(body->size()));
        }

        CURLcode rc = curl_easy_perform(curl_);
        if (rc != CURLE_OK)
            throw std::runtime_error(std::string("Network error: ") + curl_easy_strerror(rc));

        long status = 0;
        curl_easy_getinfo(curl_, CURLINFO_RESPONSE_CODE, &status);
        json j = json::parse(response, nullptr, /*allow_exceptions=*/false);

        if (status >= 400) {
            int code = 0;
            std::string msg = response, info;
            if (j.is_object()) {
                if (j.contains("code") && j["code"].is_number_integer()) code = j["code"].get<int>();
                if (!str(j, "message").empty()) msg = str(j, "message");
                info = str(j, "more_info");
            }
            throw TwilioError(status, code, msg, info);
        }
        if (j.is_discarded()) throw std::runtime_error("Invalid JSON response: " + response);
        return j;
    }
};

int main(int argc, char* argv[]) {
    const char* sid = std::getenv("TWILIO_ACCOUNT_SID");
    const char* token = std::getenv("TWILIO_AUTH_TOKEN");
    if (!sid || !token) {
        std::cerr << "Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables.\n";
        return 1;
    }
    const bool buy = argc > 1 && std::strcmp(argv[1], "--buy") == 0;

    curl_global_init(CURL_GLOBAL_DEFAULT);
    int exit_code = 0;

    try {
        TwilioClient client(sid, token);

        // 1. Check balance
        json bal = client.balance();
        std::cout << "Account balance: " << str(bal, "balance") << " "
                  << str(bal, "currency") << "\n";

        // 2. Search available US local numbers
        std::cout << "\nSearching for available numbers...\n";
        json numbers = client.search_available("US", "Local", {
            {"AreaCode", "415"},        // optional
            {"SmsEnabled", "true"},     // optional
            {"VoiceEnabled", "true"},   // optional
            {"PageSize", "5"},
        });
        // Other examples:
        //   client.search_available("US", "Local",    {{"InLocality", "San Francisco"}});
        //   client.search_available("US", "TollFree", {{"PageSize", "10"}});
        //   client.search_available("US", "Mobile",   {{"PageSize", "10"}});

        std::cout << "Found " << numbers.size() << " available numbers:\n";
        for (const auto& n : numbers)
            std::cout << "- " << str(n, "phone_number")
                      << " (Locality: " << str(n, "locality") << ")\n";

        // 3. Purchase the first one (only with --buy, since this charges your account)
        if (buy && !numbers.empty()) {
            const std::string selected = str(numbers[0], "phone_number");
            std::cout << "\nPurchasing " << selected << "...\n";

            json purchased = client.purchase({
                {"PhoneNumber", selected},
                {"FriendlyName", "My First Twilio Number"},
                // Optional configuration at purchase time:
                // {"SmsUrl", "https://yourapp.com/sms"},     {"SmsMethod", "POST"},
                // {"VoiceUrl", "https://yourapp.com/voice"}, {"VoiceMethod", "POST"},
                // {"StatusCallback", "https://yourapp.com/status"},
            });

            std::cout << "Successfully purchased: " << str(purchased, "phone_number") << "\n"
                      << "  SID: " << str(purchased, "sid") << "\n"
                      << "  Friendly Name: " << str(purchased, "friendly_name") << "\n";
        } else if (!buy) {
            std::cout << "\n(Dry run: pass --buy to purchase the first number.)\n";
        }

        // 4. List numbers you own
        std::cout << "\nYour numbers:\n";
        for (const auto& n : client.list_owned(20))
            std::cout << "- " << str(n, "phone_number") << " - " << str(n, "friendly_name") << "\n";

    } catch (const TwilioError& e) {
        std::cerr << "Twilio error " << e.code << " (HTTP " << e.status << "): " << e.what() << "\n";
        if (!e.more_info.empty()) std::cerr << "More info: " << e.more_info << "\n";
        // e.g. 20003 = authentication failed, 21422 = number not available
        exit_code = 2;
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << "\n";
        exit_code = 1;
    }

    curl_global_cleanup();
    return exit_code;
}