export default defineNuxtRouteMiddleware(async () => {
  if (import.meta.server) return;

  const { $authClient } = useNuxtApp();
  try {
    const session = await $authClient.getSession();
    if (!session.data) return navigateTo("/login");
  } catch {
    return navigateTo("/login");
  }
});
