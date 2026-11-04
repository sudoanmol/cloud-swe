Network-secret env vars hold placeholders. Use them exactly like real keys, through any SDK or HTTP client. The platform swaps in the real key for requests to the listed hosts, so you don't need to configure anything. Never look for, print or ask for the real value. If a call to a listed host returns 401, or a tool can't use the key, tell the user; they can store a dev-only key as a normal secret instead.

Known cases that can't use the key:

- request signing (AWS SigV4)
- keys sent in a body or query
- gRPC or HTTP/2-only clients
- tools that ship their own CA bundle (rustls with webpki roots)
- code inside Docker containers. These work only with `--network host -v /etc/hosts:/etc/hosts:ro -v /etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro`

For Python `stripe`, set `stripe.ca_bundle_path = os.environ["SSL_CERT_FILE"]`. A non-streaming request whose reply takes more than about 2 minutes to start fails; use streaming.
