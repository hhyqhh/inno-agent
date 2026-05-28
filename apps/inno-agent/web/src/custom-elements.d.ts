import type { HTMLAttributes } from "react";

type CustomElementProps = HTMLAttributes<HTMLElement>;

declare module "react" {
	namespace JSX {
		interface IntrinsicElements {
			"markdown-artifact": CustomElementProps & {
				content: string;
			};
		}
	}
}
