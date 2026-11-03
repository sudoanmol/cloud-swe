import os, stripe
stripe.api_key = os.environ["PH"]
for label, bundle in [("default", None), ("ca_bundle_path=SSL_CERT_FILE", os.environ["SSL_CERT_FILE"])]:
    if bundle: stripe.ca_bundle_path = bundle
    try:
        stripe.Balance.retrieve(); print(label, "unexpected success")
    except Exception as e:
        print(label, type(e).__name__, str(e)[:110].replace("\n", " "))
