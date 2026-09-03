import { mermaid } from "@streamdown/mermaid";
import { MarkdownRuntime, type MarkdownRuntimeProps } from "./MarkdownRuntime.js";

export default function MermaidMarkdownRuntime(props: MarkdownRuntimeProps) {
	return <MarkdownRuntime {...props} mermaidPlugin={mermaid} />;
}
