export function Greeting() {
  return (
    <div className="flex flex-col items-center px-4">
      <h1 className="animate-[fade-up_0.5s_cubic-bezier(0.22,1,0.36,1)_0.35s_both] text-center text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
        What should we build?
      </h1>
      <p className="mt-3 animate-[fade-up_0.5s_cubic-bezier(0.22,1,0.36,1)_0.5s_both] text-center text-sm text-muted-foreground/80">
        Pick a repository, then describe what to build or fix.
      </p>
    </div>
  );
}
