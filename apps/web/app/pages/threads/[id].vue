<script setup lang="ts">
import { ThreadApiError, type ThreadSnapshot, type ThreadStreamEvent } from "@cloud-swe/api/client";

const route = useRoute();
const client = useThreadClient();
const toast = useToast();

definePageMeta({
  middleware: ["auth"],
});

const threadId = computed(() => String(route.params.id ?? ""));
const snapshot = ref<ThreadSnapshot | null>(null);
const events = ref<ThreadStreamEvent[]>([]);
const followup = ref("");
const submitting = ref(false);
const cancelling = ref(false);
const streamError = ref("");
const seen = new Set<number>();

const activeRun = computed(() =>
  snapshot.value?.runs.find((run) => run.status === "queued" || run.status === "running"),
);

function rememberEvent(event: ThreadStreamEvent) {
  if (seen.has(event.sequence)) return;
  seen.add(event.sequence);
  events.value = [...events.value, event].sort((left, right) => left.sequence - right.sequence);
}

function payloadText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  if ("delta" in payload && typeof payload.delta === "string") return payload.delta;
  if ("content" in payload && typeof payload.content === "string") return payload.content;
  if ("output" in payload && typeof payload.output === "string") return payload.output;
  if ("command" in payload && typeof payload.command === "string") return payload.command;
  return "";
}

async function refreshSnapshot() {
  snapshot.value = await client.getThread(threadId.value);
}

async function sendFollowup() {
  const text = followup.value.trim();
  if (!text || submitting.value) return;
  submitting.value = true;
  try {
    await client.submitMessage({
      threadId: threadId.value,
      prompt: text,
      clientMessageId: crypto.randomUUID(),
    });
    followup.value = "";
    await refreshSnapshot();
  } catch (error: unknown) {
    toast.add({
      title: "Follow-up failed",
      description: error instanceof ThreadApiError ? error.message : "Unable to send message",
    });
  } finally {
    submitting.value = false;
  }
}

async function cancelActiveRun() {
  if (!activeRun.value || cancelling.value) return;
  cancelling.value = true;
  try {
    await client.cancelRun({ threadId: threadId.value, runId: activeRun.value.id });
    await refreshSnapshot();
  } catch (error: unknown) {
    toast.add({
      title: "Cancel failed",
      description: error instanceof ThreadApiError ? error.message : "Unable to cancel run",
    });
  } finally {
    cancelling.value = false;
  }
}

onMounted(async () => {
  const abort = new AbortController();
  onUnmounted(() => abort.abort());
  try {
    await refreshSnapshot();
  } catch (error: unknown) {
    streamError.value = error instanceof ThreadApiError ? error.message : "Unable to load thread";
    return;
  }

  let cursor = 0;
  while (!abort.signal.aborted) {
    try {
      await client.streamEvents({
        threadId: threadId.value,
        after: cursor,
        signal: abort.signal,
        onEvent: (event) => {
          rememberEvent(event);
          cursor = Math.max(cursor, event.sequence);
        },
      });
    } catch (error: unknown) {
      if (abort.signal.aborted) return;
      if (error instanceof Error && error.name === "AbortError") return;
      if (
        error instanceof ThreadApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429
      ) {
        streamError.value = error.message;
        return;
      }
      streamError.value =
        error instanceof ThreadApiError ? error.message : "Event stream disconnected";
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
});
</script>

<template>
  <UContainer class="py-8">
    <UPageHeader title="Thread" :description="threadId">
      <template #trailing>
        <UButton
          v-if="activeRun"
          color="neutral"
          variant="outline"
          :loading="cancelling"
          @click="cancelActiveRun"
        >
          Cancel run
        </UButton>
      </template>
    </UPageHeader>

    <UAlert
      v-if="streamError"
      class="mt-4"
      color="warning"
      icon="i-lucide-wifi-off"
      title="Stream"
      :description="streamError"
    />

    <div class="mt-6 space-y-4">
      <UCard v-for="message in snapshot?.messages ?? []" :key="message.id">
        <template #header>
          <div class="font-medium capitalize">{{ message.role }}</div>
        </template>
        <pre class="text-sm whitespace-pre-wrap">{{ message.content }}</pre>
      </UCard>

      <UCard v-for="event in events" :key="event.sequence">
        <template #header>
          <div class="font-medium">{{ event.type }} · {{ event.sequence }}</div>
        </template>
        <pre class="text-sm whitespace-pre-wrap">{{
          payloadText(event.payload) || JSON.stringify(event.payload)
        }}</pre>
      </UCard>
    </div>

    <form class="mt-6 space-y-3" @submit.prevent="sendFollowup">
      <UTextarea v-model="followup" autoresize :rows="3" placeholder="Send a follow-up" />
      <UButton type="submit" :loading="submitting" :disabled="!followup.trim()"> Send </UButton>
    </form>
  </UContainer>
</template>
