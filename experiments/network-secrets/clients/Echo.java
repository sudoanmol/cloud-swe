import java.net.URI; import java.net.http.*;
public class Echo { public static void main(String[] a) throws Exception {
  var c = HttpClient.newHttpClient();
  var r = c.send(HttpRequest.newBuilder(URI.create("https://" + System.getenv("SLOW") + "/echo")).header("Authorization", "Bearer " + System.getenv("PH")).build(), HttpResponse.BodyHandlers.ofString());
  var p = c.send(HttpRequest.newBuilder(URI.create("https://example.com")).build(), HttpResponse.BodyHandlers.discarding());
  System.out.println("java status=" + r.statusCode() + " swapped=" + r.body().contains("Bearer " + System.getenv("DUMMY")) + " public=" + p.statusCode());
} }
