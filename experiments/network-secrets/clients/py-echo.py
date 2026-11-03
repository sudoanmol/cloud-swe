import json, os, sys, urllib.request
PH = os.environ["PH"]
lib = sys.argv[1]
url, hdr = "https://httpbin.org/anything", {"Authorization": "Bearer " + PH}
if lib == "requests":
    import requests
    auth = requests.get(url, headers=hdr).json()["headers"]["Authorization"]; pub = requests.get("https://example.com").status_code
elif lib == "httpx":
    import httpx
    auth = httpx.get(url, headers=hdr).json()["headers"]["Authorization"]; pub = httpx.get("https://example.com").status_code
elif lib == "urllib":
    auth = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=hdr)))["headers"]["Authorization"]
    pub = urllib.request.urlopen("https://example.com").status
elif lib == "aiohttp":
    import asyncio, aiohttp
    async def main():
        async with aiohttp.ClientSession() as s:
            async with s.get(url, headers=hdr) as r: a = (await r.json())["headers"]["Authorization"]
            async with s.get("https://example.com") as r: return a, r.status
    auth, pub = asyncio.run(main())
print(json.dumps({"auth": auth, "public": pub}))
