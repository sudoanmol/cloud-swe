import { useId, type SVGProps } from "react";

// Same mark as public/favicon.svg, which uses fixed colors so it shows on any tab bar.
export function Logo(props: SVGProps<SVGSVGElement>) {
  const maskId = useId();

  return (
    <svg aria-hidden="true" fill="currentColor" viewBox="0 0 32 32" {...props}>
      <mask id={maskId}>
        <rect fill="#fff" height="32" width="32" />
        <path
          d="m11 13.5 3.5 3.5-3.5 3.5m6 0h4.5"
          fill="none"
          stroke="#000"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2.5}
        />
      </mask>
      <rect height="32" mask={`url(#${maskId})`} rx="8" width="32" />
    </svg>
  );
}
