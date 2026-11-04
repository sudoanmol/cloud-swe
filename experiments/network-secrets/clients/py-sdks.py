import json, os
PH = os.environ["PH"]
out = {}
def probe(name, call):
    try:
        call(); out[name] = "unexpected success"
    except Exception as e:
        out[name] = f"{type(e).__name__} {getattr(e, 'status_code', '')} {str(e)[:160]}"
import openai, anthropic, stripe
probe("openai", lambda: openai.OpenAI(api_key=PH).models.list())
probe("anthropic", lambda: anthropic.Anthropic(api_key=PH).models.list())
stripe.api_key = PH
probe("stripe", lambda: stripe.Balance.retrieve())
print(json.dumps(out))
