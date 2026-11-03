import json, os, time, anthropic
c = anthropic.Anthropic(api_key=os.environ["PH"]); out = {}
for model in ["claude-haiku-5-5", "claude-haiku-4-5", "claude-3-5-haiku-latest"]:
    try:
        t = time.time(); deltas = []
        with c.messages.stream(model=model, max_tokens=60, messages=[{"role": "user", "content": "Say hello in five words."}]) as s:
            for _ in s.text_stream: deltas.append(int((time.time() - t) * 1000))
            final = s.get_final_message()
        out["anthropicPythonStream"] = {"model": model, "deltas": len(deltas), "firstMs": deltas[0] if deltas else None, "text": final.content[0].text[:40]}
        break
    except Exception as e:
        out[f"anthropic {model}"] = f"{type(e).__name__} {str(e)[:100]}"
print(json.dumps(out))
