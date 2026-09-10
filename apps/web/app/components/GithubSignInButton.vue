<script setup lang="ts">
const { $authClient } = useNuxtApp();
const config = useRuntimeConfig();

const toast = useToast();
const loading = ref(false);
const githubSignIn = Boolean(config.public.githubSignIn);

async function signInWithGithub() {
  loading.value = true;
  try {
    await $authClient.signIn.social({
      provider: "github",
      callbackURL: `${window.location.origin}/dashboard`,
      errorCallbackURL: `${window.location.origin}/login`,
    });
  } catch (error: unknown) {
    toast.add({
      title: "GitHub sign in failed",
      description: error instanceof Error ? error.message : "Please try again.",
    });
    loading.value = false;
  }
}
</script>

<template>
  <UButton
    v-if="githubSignIn"
    block
    color="neutral"
    variant="outline"
    icon="i-lucide-github"
    label="Continue with GitHub"
    :loading="loading"
    @click="signInWithGithub"
  />
</template>
