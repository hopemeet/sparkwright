import type {
  ContentBlock,
  EmbeddedResourceResource,
} from "@agentclientprotocol/sdk";

export function contentBlocksToText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map(contentBlockToText)
    .filter((text) => text.trim().length > 0)
    .join("\n\n")
    .trim();
}

export function contentBlockToText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "resource_link":
      return formatResourceLink(block.name, block.uri);
    case "resource":
      return embeddedResourceToText(block.resource);
    case "image":
      return block.uri
        ? `[image: ${block.mimeType} ${block.uri}]`
        : `[image: ${block.mimeType}]`;
    case "audio":
      return `[audio: ${block.mimeType}]`;
  }
}

function embeddedResourceToText(resource: EmbeddedResourceResource): string {
  if ("text" in resource) {
    return [`Resource: ${resource.uri}`, resource.text].join("\n");
  }
  return `Resource: ${resource.uri} (${resource.mimeType})`;
}

function formatResourceLink(name: string, uri: string): string {
  return name ? `Resource: ${name} <${uri}>` : `Resource: ${uri}`;
}
