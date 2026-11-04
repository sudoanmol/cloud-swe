import os, urllib.request, urllib.error
for url in ["https://httpbin.org/anything", "https://example.com"]:
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": "Bearer " + os.environ["PH"]}))
        print(url, r.status, r.read(120))
    except urllib.error.HTTPError as e:
        print(url, e.code, e.read(300))
