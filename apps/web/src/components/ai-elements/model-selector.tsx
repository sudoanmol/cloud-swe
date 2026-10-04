import type { ComponentProps } from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export { Popover as ModelSelector, PopoverTrigger as ModelSelectorTrigger };

export type ModelSelectorContentProps = ComponentProps<typeof PopoverContent> & {
  commandDefaultValue?: ComponentProps<typeof Command>["defaultValue"];
};

export const ModelSelectorContent = ({
  className,
  commandDefaultValue,
  children,
  ...props
}: ModelSelectorContentProps) => (
  <PopoverContent
    align="start"
    className={cn(
      "w-[280px] p-0 rounded-xl border border-border/60 bg-card/95 backdrop-blur-xl shadow-[var(--shadow-float)]",
      className,
    )}
    side="top"
    sideOffset={8}
    {...props}
  >
    <Command
      className="**:data-[slot=command-input-wrapper]:h-auto"
      defaultValue={commandDefaultValue}
    >
      {children}
    </Command>
  </PopoverContent>
);

export type ModelSelectorInputProps = ComponentProps<typeof CommandInput>;

export const ModelSelectorInput = ({ className, ...props }: ModelSelectorInputProps) => (
  <CommandInput className={cn("h-auto py-2.5 text-[13px]", className)} {...props} />
);

export type ModelSelectorListProps = ComponentProps<typeof CommandList>;

export const ModelSelectorList = ({ className, ...props }: ModelSelectorListProps) => (
  <CommandList className={cn("max-h-[280px]", className)} {...props} />
);

export { CommandEmpty as ModelSelectorEmpty, CommandGroup as ModelSelectorGroup };

export type ModelSelectorItemProps = ComponentProps<typeof CommandItem>;

export const ModelSelectorItem = ({ className, ...props }: ModelSelectorItemProps) => (
  <CommandItem className={cn("w-full text-[13px] rounded-lg", className)} {...props} />
);

export type ModelSelectorLogoProps = Omit<ComponentProps<"img">, "src" | "alt"> & {
  provider: string;
};

export const ModelSelectorLogo = ({ provider, className, ...props }: ModelSelectorLogoProps) => (
  <img
    {...props}
    alt={`${provider} logo`}
    className={cn("size-4 dark:invert", className)}
    height={16}
    src={`https://models.dev/logos/${provider}.svg`}
    width={16}
  />
);

export type ModelSelectorNameProps = ComponentProps<"span">;

export const ModelSelectorName = ({ className, ...props }: ModelSelectorNameProps) => (
  <span className={cn("flex-1 truncate text-left", className)} {...props} />
);
