import { redirect } from "next/navigation";

/** `/login` is a redirect, not a second login screen. */
export default function Page() {
  redirect("/");
}
