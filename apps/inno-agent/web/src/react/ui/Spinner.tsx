interface SpinnerProps {
	size?: number;
	className?: string;
}

/**
 * Border-pattern spinner (the majority pattern across the codebase, 12:1 over
 * Loader2). Color follows `currentColor` so it inherits text color. The
 * `border-t-transparent` creates the spinning-gap effect.
 */
export function Spinner({ size = 14, className = "" }: SpinnerProps) {
	return (
		<span
			aria-hidden="true"
			className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
			style={{ width: size, height: size }}
		/>
	);
}
