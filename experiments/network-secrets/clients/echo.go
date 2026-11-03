package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
)

func main() {
	req, _ := http.NewRequest("GET", "https://httpbin.org/anything", nil)
	req.Header.Set("Authorization", "Bearer "+os.Getenv("PH"))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Println(`{"error":` + fmt.Sprintf("%q", err.Error()) + `}`)
		return
	}
	var body struct{ Headers map[string]string }
	json.NewDecoder(res.Body).Decode(&body)
	pub, err := http.Get("https://example.com")
	status := 0
	if err == nil {
		status = pub.StatusCode
	}
	out, _ := json.Marshal(map[string]any{"auth": body.Headers["Authorization"], "public": status})
	fmt.Println(string(out))
}
