import json, os
PH = os.environ["PH"]; out = {}
def probe(name, call):
    try: call(); out[name] = "unexpected success"
    except Exception as e: out[name] = f"{type(e).__name__} {str(e)[:110]}".replace("\n", " ")
def genai():
    from google import genai; c = genai.Client(api_key=PH); list(c.models.list())
def groq():
    import groq; groq.Groq(api_key=PH).models.list()
def mistral():
    try:
        from mistralai import Mistral
    except ImportError:
        from mistralai.client import Mistral
    Mistral(api_key=PH).models.list()
def cohere():
    import cohere; cohere.ClientV2(api_key=PH).models.list()
def replicate():
    import replicate; replicate.Client(api_token=PH).accounts.current()
def httplib2_():
    import httplib2; r, c = httplib2.Http().request("https://httpbin.org/anything", headers={"Authorization": "Bearer " + PH}); print("httplib2 echo:", json.loads(c)["headers"]["Authorization"][:12])
for n, f in [("google-genai", genai), ("groq", groq), ("mistralai", mistral), ("cohere", cohere), ("replicate", replicate), ("httplib2", httplib2_)]: probe(n, f)
print(json.dumps(out, indent=1))
