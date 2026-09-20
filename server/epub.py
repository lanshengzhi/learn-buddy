"""EPUB parsing for the Library — stdlib only.

Pipeline: `META-INF/container.xml` → OPF (metadata, manifest, spine) →
navigation (EPUB3 nav → NCX → spine fallback) → chapters sliced by the
navigation anchors. A Chapter may span spine documents and may be a slice of
one, so slicing works on absolute `(spine_index, character_offset)` positions.

Output is the baked chapter product from #16: sentences carrying their word
lengths and ruby annotations (`textseg`), with a `parseVersion` for future
re-parses. Images are dropped but their `alt` text is kept; `<rt>`/`<rp>`
source ruby is dropped (Sudachi supplies the readings).

Errors carry the API code: `not_epub` when the bytes are not a zip or carry no
OPF, `parse_failed` when they are a zip but not a readable epub.
"""

import html.parser
import io
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET
from urllib.parse import unquote

import textseg

PARSE_VERSION = 1

OPF_MEDIA_TYPE = "application/oebps-package+xml"
NCX_MEDIA_TYPE = "application/x-dtbncx+xml"
_XHTML_MEDIA_TYPES = ("application/xhtml+xml", "text/html")

_WHITESPACE_RE = re.compile(r"\s+")
_HAN_RE = textseg.KANJI_RE
_KANA_RE = re.compile(r"[\u3040-\u30ff\uff66-\uff9f]")

_BLOCK_TAGS = {
    "address", "article", "aside", "blockquote", "body", "br", "caption",
    "dd", "div", "dl", "dt", "figcaption", "figure", "footer", "h1", "h2",
    "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p",
    "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr",
    "ul",
}
_SKIP_TAGS = {"script", "style", "rt", "rp"}
_HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}


class ParseError(Exception):
    """A book could not be parsed; `code` is the API error code."""

    def __init__(self, code, message=""):
        super().__init__(message or code)
        self.code = code
        self.message = message


def parse_epub(data, ja_tokenizer=None, zh_tokenizer=None):
    """Parse epub bytes into `{title, author, lang, chapters}`."""
    ja_tokenizer = ja_tokenizer or textseg.tokenize_ja
    zh_tokenizer = zh_tokenizer or textseg.tokenize_zh
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, OSError) as error:
        raise ParseError("not_epub", f"not a zip archive: {error}") from error
    with archive:
        opf_path = _find_opf(archive)
        opf = _parse_opf(archive, opf_path)
        docs = _load_documents(archive, opf)
        lang = _book_language(opf, docs)
        destinations = _load_destinations(archive, opf, docs)
        chapters = _build_chapters(docs, destinations, lang, ja_tokenizer, zh_tokenizer)
        if not chapters:
            raise ParseError("parse_failed", "no readable text chapters")
        return {
            "title": opf["title"],
            "author": opf["author"],
            "lang": lang,
            "chapters": chapters,
        }


# -- container / OPF -------------------------------------------------------


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _iter(root, name):
    for element in root.iter():
        if _local(element.tag) == name:
            yield element


def _find_opf(archive):
    try:
        raw = archive.read("META-INF/container.xml")
    except KeyError as error:
        raise ParseError("not_epub", "META-INF/container.xml is missing") from error
    except zipfile.BadZipFile as error:
        raise ParseError("not_epub", f"container.xml is corrupt: {error}") from error
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as error:
        raise ParseError("not_epub", "container.xml is not XML") from error
    for element in _iter(root, "rootfile"):
        path = element.get("full-path")
        if path:
            return posixpath.normpath(path.lstrip("/"))
    raise ParseError("not_epub", "container.xml has no rootfile")


def _parse_opf(archive, opf_path):
    try:
        raw = archive.read(opf_path)
    except KeyError as error:
        raise ParseError("not_epub", f"{opf_path} is missing from the archive") from error
    except zipfile.BadZipFile as error:
        raise ParseError("parse_failed", f"{opf_path} is corrupt: {error}") from error
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as error:
        raise ParseError("parse_failed", f"OPF is not XML: {error}") from error

    metadata = {"title": "", "author": "", "language": ""}
    field_for = {"title": "title", "creator": "author", "language": "language"}
    for element in root.iter():
        field = field_for.get(_local(element.tag))
        if field and not metadata[field]:
            metadata[field] = "".join(element.itertext()).strip()

    manifest = {}
    for item in _iter(root, "item"):
        item_id = item.get("id")
        if not item_id:
            continue
        manifest[item_id] = {
            "href": item.get("href") or "",
            "media_type": (item.get("media-type") or "").strip().lower(),
            "properties": item.get("properties") or "",
        }

    spine = []
    toc_id = None
    for element in root.iter():
        name = _local(element.tag)
        if name == "spine":
            toc_id = element.get("toc")
        elif name == "itemref":
            idref = element.get("idref")
            if idref:
                spine.append({"idref": idref, "linear": element.get("linear") != "no"})
    if not spine:
        raise ParseError("parse_failed", "OPF spine is empty")
    return {
        "dir": posixpath.dirname(opf_path),
        "manifest": manifest,
        "spine": spine,
        "toc_id": toc_id,
        **metadata,
    }


def _resolve_path(base_dir, href):
    path = unquote(href.split("#", 1)[0])
    joined = posixpath.join(base_dir, path) if base_dir else path
    return posixpath.normpath(joined)


def _read_entry(archive, path):
    try:
        return archive.read(path)
    except KeyError as error:
        raise ParseError("parse_failed", f"{path} is missing from the archive") from error
    except zipfile.BadZipFile as error:
        raise ParseError("parse_failed", f"{path} is corrupt: {error}") from error


def _decode(raw):
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig", "replace")
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16", "replace")
    head = raw[:256].decode("ascii", "ignore")
    match = re.search(r'encoding=["\']([A-Za-z0-9_\-]+)["\']', head)
    if not match:
        match = re.search(r'charset=["\']?([A-Za-z0-9_\-]+)', head)
    encoding = match.group(1) if match else "utf-8"
    try:
        return raw.decode(encoding)
    except (LookupError, UnicodeDecodeError):
        return raw.decode("utf-8", "replace")


# -- spine documents -------------------------------------------------------


def _empty_doc():
    return {"text": "", "anchors": {}, "title": "", "heading": ""}


def _load_documents(archive, opf):
    documents = []
    for entry in opf["spine"]:
        item = opf["manifest"].get(entry["idref"])
        if not item or not _is_text_document(item):
            documents.append(_empty_doc())
            continue
        path = _resolve_path(opf["dir"], item["href"])
        documents.append(_extract_document(_decode(_read_entry(archive, path))))
    return documents


def _is_text_document(item):
    if item["media_type"] in _XHTML_MEDIA_TYPES:
        return True
    if item["media_type"]:
        return False
    return item["href"].lower().endswith((".xhtml", ".html", ".htm"))


class _DocumentParser(html.parser.HTMLParser):
    """Collects block-level text, element-id anchors, and `<title>`/heading."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []
        self.buffer = []
        self.buffer_anchors = []
        # Anchors seen in an empty run of markup (e.g. <a id="c3"></a>) point
        # at the start of the next real block, not at nothing.
        self.carried_anchors = []
        self.skip_depth = 0
        self.in_head = False
        self.in_title = False
        self.title_parts = []
        self.heading_parts = []
        self.in_heading = False

    # -- text ------------------------------------------------------------

    def handle_data(self, data):
        if self.in_title:
            self.title_parts.append(data)
        if self.in_heading and not self.in_head:
            self.heading_parts.append(data)
        if self.skip_depth or self.in_head or not data:
            return
        if data.isspace():
            self.buffer.append(" ")
            return
        self.buffer.append(_WHITESPACE_RE.sub(" ", data))

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "head":
            self.in_head = True
        if tag == "title":
            self.in_title = True
        if tag in _SKIP_TAGS:
            self.skip_depth += 1
        if tag in _BLOCK_TAGS:
            self._flush()
        if self.skip_depth or self.in_head:
            return
        anchor_id = attributes.get("id")
        if not anchor_id and tag == "a":
            anchor_id = attributes.get("name")
        if anchor_id and all(existing != anchor_id for existing, _ in self.buffer_anchors):
            self.buffer_anchors.append((anchor_id, len("".join(self.buffer))))
        if tag == "img" and attributes.get("alt"):
            self.buffer.append(attributes["alt"])
        if tag in _HEADING_TAGS and not self.in_heading:
            self.in_heading = True
            self.heading_parts = []

    def handle_endtag(self, tag):
        if tag == "head":
            self.in_head = False
        if tag == "title":
            self.in_title = False
        if tag in _HEADING_TAGS and self.in_heading:
            self.in_heading = False
        if tag in _SKIP_TAGS:
            self.skip_depth = max(0, self.skip_depth - 1)
        if tag in _BLOCK_TAGS:
            self._flush()

    # -- assembly --------------------------------------------------------

    def _flush(self):
        joined = "".join(self.buffer)
        text = joined.strip()
        anchors = self.buffer_anchors + self.carried_anchors
        if text:
            leading = len(joined) - len(joined.lstrip())
            self.blocks.append({
                "text": text,
                "anchors": {
                    anchor_id: max(0, min(offset - leading, len(text)))
                    for anchor_id, offset in anchors
                },
            })
            self.carried_anchors = []
        else:
            self.carried_anchors = [(anchor_id, 0) for anchor_id, _ in anchors]
        self.buffer = []
        self.buffer_anchors = []

    def finish(self):
        # close() first so HTMLParser flushes any trailing buffered text into
        # handle_data; then emit the last block.
        self.close()
        self._flush()
        text = "\n".join(block["text"] for block in self.blocks)
        anchors = {}
        position = 0
        for block in self.blocks:
            for anchor_id, offset in block["anchors"].items():
                anchors[anchor_id] = position + offset
            position += len(block["text"]) + 1
        # An anchor whose empty element ran to the document end.
        for anchor_id, _ in self.carried_anchors:
            anchors[anchor_id] = len(text)
        return {
            "text": text,
            "anchors": anchors,
            "title": _WHITESPACE_RE.sub(" ", "".join(self.title_parts)).strip(),
            "heading": _WHITESPACE_RE.sub(" ", "".join(self.heading_parts)).strip(),
        }


def _extract_document(markup):
    parser = _DocumentParser()
    parser.feed(markup)
    return parser.finish()


# -- language --------------------------------------------------------------


def _book_language(opf, documents):
    declared = (opf.get("language") or "").strip().lower()
    primary = re.split(r"[-_]", declared)[0] if declared else ""
    if primary in ("ja", "zh", "en"):
        return primary
    sample = "\n".join(document["text"][:2000] for document in documents[:4])
    if _KANA_RE.search(sample):
        return "ja"
    if _HAN_RE.search(sample):
        return "zh"
    return primary or "en"


# -- navigation ------------------------------------------------------------


def _load_destinations(archive, opf, documents):
    """Nav destinations as `(spine_index, offset, title)`, sorted by position."""
    for loader in (_load_nav_links, _load_ncx_links):
        try:
            links = loader(archive, opf)
        except ParseError:
            continue
        resolved = _resolve_positions(links, opf, documents)
        if resolved:
            return resolved
    return []


def _resolve_positions(links, opf, documents):
    spine_paths = {}
    for index, entry in enumerate(opf["spine"]):
        item = opf["manifest"].get(entry["idref"])
        if item:
            spine_paths[_resolve_path(opf["dir"], item["href"])] = index
    positioned = []
    for title, href in links:
        path, _, fragment = href.partition("#")
        index = spine_paths.get(_resolve_path(opf["dir"], path))
        if index is None:
            continue
        offset = documents[index]["anchors"].get(unquote(fragment), 0) if fragment else 0
        positioned.append((index, offset, title.strip()))
    positioned.sort(key=lambda entry: (entry[0], entry[1]))
    return positioned


def _load_nav_links(archive, opf):
    for item in opf["manifest"].values():
        if "nav" not in item["properties"].split():
            continue
        path = _resolve_path(opf["dir"], item["href"])
        markup = _decode(_read_entry(archive, path))
        links = _parse_nav(markup)
        if links:
            return links
    return []


def _parse_nav(markup):
    parser = _NavParser()
    parser.feed(markup)
    parser.close()
    return parser.toc_links()


class _NavParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.navs = []
        self.orphans = []
        self.current = None
        self.link_href = None
        self.link_text = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "nav":
            is_toc = "toc" in (attributes.get("epub:type") or "").split()
            self.current = {"toc": is_toc, "links": []}
            self.navs.append(self.current)
        elif tag == "a":
            self.link_href = attributes.get("href")
            self.link_text = []

    def handle_data(self, data):
        if self.link_href is not None:
            self.link_text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self.link_href is not None:
            title = _WHITESPACE_RE.sub(" ", "".join(self.link_text)).strip()
            if self.link_href:
                target = self.current["links"] if self.current else self.orphans
                target.append((title, self.link_href))
            self.link_href = None
        elif tag == "nav":
            self.current = None

    def toc_links(self):
        for nav in self.navs:
            if nav["toc"] and nav["links"]:
                return nav["links"]
        for nav in self.navs:
            if nav["links"]:
                return nav["links"]
        return self.orphans


def _load_ncx_links(archive, opf):
    item = None
    for candidate in opf["manifest"].values():
        if candidate["media_type"] == NCX_MEDIA_TYPE:
            item = candidate
            break
    if item is None and opf.get("toc_id"):
        candidate = opf["manifest"].get(opf["toc_id"])
        if candidate and candidate["media_type"] == NCX_MEDIA_TYPE:
            item = candidate
    if item is None:
        for candidate in opf["manifest"].values():
            if candidate["href"].lower().endswith(".ncx"):
                item = candidate
                break
    if item is None:
        return []
    path = _resolve_path(opf["dir"], item["href"])
    try:
        root = ET.fromstring(_read_entry(archive, path))
    except ET.ParseError as error:
        raise ParseError("parse_failed", f"NCX is not XML: {error}") from error
    links = []
    for nav_point in _iter(root, "navPoint"):
        label = ""
        for text_element in _iter(nav_point, "text"):
            label = "".join(text_element.itertext()).strip()
            break
        content = next(_iter(nav_point, "content"), None)
        if content is not None and content.get("src"):
            links.append((label, content.get("src")))
    return links


# -- chapters --------------------------------------------------------------


def _build_chapters(documents, destinations, lang, ja_tokenizer, zh_tokenizer):
    if destinations:
        starts = destinations
    else:
        starts = [
            (index, 0, document["heading"] or document["title"])
            for index, document in enumerate(documents)
            if document["text"].strip()
        ]
        starts.sort(key=lambda entry: entry[0])
    chapters = []
    for position, (index, offset, title) in enumerate(starts):
        end = starts[position + 1][:2] if position + 1 < len(starts) else None
        text = _slice_text(documents, (index, offset), end).strip()
        if not text:
            continue
        sentences = []
        try:
            for sentence in textseg.split_sentences(text, lang):
                sentences.append(_annotate(sentence, lang, ja_tokenizer, zh_tokenizer))
        except textseg.TokenizerUnavailable as error:
            raise ParseError("parse_failed", str(error)) from error
        if not sentences:
            continue
        chapters.append({
            "title": title.strip() or f"Chapter {len(chapters) + 1}",
            "sentences": sentences,
        })
    return chapters


def _annotate(sentence, lang, ja_tokenizer, zh_tokenizer):
    try:
        return textseg.annotate(sentence, lang, ja_tokenizer, zh_tokenizer)
    except textseg.TokenizerUnavailable:
        raise
    except Exception as error:
        raise ParseError("parse_failed", f"tokenizer failed: {error}") from error


def _slice_text(documents, start, end):
    start_index, start_offset = start
    if end is None:
        end_index = len(documents) - 1
        end_offset = len(documents[end_index]["text"])
    else:
        end_index, end_offset = end
    if (end_index, end_offset) < (start_index, start_offset):
        return ""
    parts = []
    for index in range(start_index, end_index + 1):
        text = documents[index]["text"]
        begin = min(start_offset, len(text)) if index == start_index else 0
        finish = min(end_offset, len(text)) if index == end_index else len(text)
        if finish > begin:
            parts.append(text[begin:finish])
    return "\n".join(parts)
