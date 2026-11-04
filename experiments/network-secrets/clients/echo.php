<?php
$c = curl_init("https://" . getenv("SLOW") . "/echo"); curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => ["Authorization: Bearer " . getenv("PH")]]);
$b = curl_exec($c); $e = curl_error($c);
$j = json_decode($b, true); echo "php status=" . curl_getinfo($c, CURLINFO_HTTP_CODE) . " swapped=" . var_export(($j["headers"]["Authorization"] ?? "") === "Bearer " . getenv("DUMMY"), true) . " err=$e";
$s = file_get_contents("https://example.com"); echo " stream-public=" . ($s ? "ok" : "fail") . "\n";
