require "net/http"; require "json"
uri = URI("https://httpbin.org/anything")
req = Net::HTTP::Get.new(uri); req["Authorization"] = "Bearer " + ENV["PH"]
res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |h| h.request(req) }
pub = Net::HTTP.get_response(URI("https://example.com")).code.to_i
puts({ auth: JSON.parse(res.body)["headers"]["Authorization"], public: pub }.to_json)
