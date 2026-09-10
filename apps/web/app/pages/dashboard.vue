<script setup lang="ts">
import { ThreadApiError } from "@cloud-swe/api/client";

const { $authClient } = useNuxtApp();
const client = useThreadClient();

definePageMeta({
  middleware: ["auth"],
});

const session = $authClient.useSession();
const toast = useToast();
const submitting = ref(false);
const prompt = ref("");
const repositoryUrl = ref("");
const branch = ref("");

async function createThread() {
  const text = prompt.value.trim();
  if (!text || submitting.value) return;
  submitting.value = true;
  try {
    const result = await client.createThread({
      prompt: text,
      clientMessageId: crypto.randomUUID(),
      ...(repositoryUrl.value.trim() ? { repositoryUrl: repositoryUrl.value.trim() } : {}),
      ...(branch.value.trim() ? { branch: branch.value.trim() } : {}),
    });
    await navigateTo(`/threads/${result.threadId}`);
  } catch (error: unknown) {
    const description =
      error instanceof ThreadApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Unable to start a thread";
    toast.add({ title: "Could not start thread", description });
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <UContainer class="py-8">
    <UPageHeader
      title="New thread"
      :description="session?.data?.user ? `Signed in as ${session.data.user.name}` : 'Loading...'"
    />

    <UCard class="mt-6">
      <template #header>
        <div class="font-medium">Start a run</div>
      </template>

      <form class="space-y-4" @submit.prevent="createThread">
        <UTextarea v-model="prompt" autoresize :rows="4" placeholder="What should the agent do?" />
        <UInput v-model="repositoryUrl" placeholder="Public GitHub URL (optional)" />
        <UInput v-model="branch" placeholder="Branch (optional)" />
        <UButton type="submit" :loading="submitting" :disabled="!prompt.trim()">
          Create thread
        </UButton>
      </form>
    </UCard>
  </UContainer>
</template>
