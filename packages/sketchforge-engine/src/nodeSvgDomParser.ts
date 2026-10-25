import { DOMParser as XmlDomParser } from "@xmldom/xmldom";

type XmlNodeWithSelectors = Node & {
  querySelectorAll?: (selector: string) => Element[];
  querySelector?: (selector: string) => Element | null;
};

function descendantsMatching(root: Node, selector: string) {
  const names = new Set(selector.split(",").map((name) => name.trim()).filter(Boolean));
  const matches: Element[] = [];
  const visit = (parent: Node) => {
    for (const child of Array.from(parent.childNodes ?? [])) {
      if (child.nodeType === 1) {
        const element = child as Element;
        const name = element.localName || element.nodeName.split(":").at(-1) || "";
        if (names.has(name)) matches.push(element);
      }
      visit(child);
    }
  };
  visit(root);
  return matches;
}

/** Add the two simple tag selectors used by three's SVGLoader to an XML tree. */
function addSvgSelectors(node: Node) {
  const target = node as XmlNodeWithSelectors;
  Object.defineProperties(target, {
    querySelectorAll: { configurable: true, value: (selector: string) => descendantsMatching(node, selector) },
    querySelector: { configurable: true, value: (selector: string) => descendantsMatching(node, selector)[0] ?? null },
  });
  for (const child of Array.from(node.childNodes ?? [])) addSvgSelectors(child);
}

class NodeDOMParser extends XmlDomParser {
  override parseFromString(source: string, mimeType?: string): Document {
    const document = super.parseFromString(source, mimeType);
    addSvgSelectors(document);
    return document;
  }
}

/** Keep the fallback parser local to one synchronous SVGLoader parse call. */
export function withNodeSvgDomParser<T>(parse: () => T): T {
  if (typeof globalThis.DOMParser !== "undefined") return parse();
  const globalWithParser = globalThis as unknown as { DOMParser?: typeof DOMParser };
  const previous = globalWithParser.DOMParser;
  globalWithParser.DOMParser = NodeDOMParser as typeof DOMParser;
  try {
    return parse();
  } finally {
    if (previous) globalWithParser.DOMParser = previous;
    else delete globalWithParser.DOMParser;
  }
}
