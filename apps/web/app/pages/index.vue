<script setup lang="ts">
const TITLE_TEXT = `
 ██████╗ ███████╗████████╗████████╗███████╗██████╗
 ██╔══██╗██╔════╝╚══██╔══╝╚══██╔══╝██╔════╝██╔══██╗
 ██████╔╝█████╗     ██║      ██║   █████╗  ██████╔╝
 ██╔══██╗██╔══╝     ██║      ██║   ██╔══╝  ██╔══██╗
 ██████╔╝███████╗   ██║      ██║   ███████╗██║  ██║
 ╚═════╝ ╚══════╝   ╚═╝      ╚═╝   ╚══════╝╚═╝  ╚═╝

 ████████╗    ███████╗████████╗ █████╗  ██████╗██╗  ██╗
 ╚══██╔══╝    ██╔════╝╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝
    ██║       ███████╗   ██║   ███████║██║     █████╔╝
    ██║       ╚════██║   ██║   ██╔══██║██║     ██╔═██╗
    ██║       ███████║   ██║   ██║  ██║╚██████╗██║  ██╗
    ╚═╝       ╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝
 `;

const client = useThreadClient();
const status = ref<"loading" | "ok" | "error">("loading");
const detail = ref("");

onMounted(async () => {
  try {
    detail.value = await client.healthCheck();
    status.value = "ok";
  } catch (error: unknown) {
    status.value = "error";
    detail.value = error instanceof Error ? error.message : "Failed to connect";
  }
});
</script>

<template>
  <UContainer class="py-8">
    <pre class="overflow-x-auto font-mono text-sm whitespace-pre-wrap">{{ TITLE_TEXT }}</pre>

    <div class="grid gap-6 mt-6">
      <UCard>
        <template #header>
          <div class="font-medium">API Status</div>
        </template>

        <div class="flex items-center gap-2">
          <UIcon
            :name="
              status === 'loading'
                ? 'i-lucide-loader-2'
                : status === 'ok'
                  ? 'i-lucide-check-circle'
                  : 'i-lucide-x-circle'
            "
            :class="[
              status === 'loading' ? 'animate-spin text-muted' : '',
              status === 'ok' ? 'text-success' : '',
              status === 'error' ? 'text-error' : '',
            ]"
          />
          <span class="text-sm">
            <template v-if="status === 'loading'"> Checking... </template>
            <template v-else-if="status === 'ok'"> Connected ({{ detail }}) </template>
            <template v-else> Error: {{ detail }} </template>
          </span>
        </div>
      </UCard>
    </div>
  </UContainer>
</template>
