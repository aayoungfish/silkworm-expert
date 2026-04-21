import json
import os
import re
import sys
from datetime import datetime, timezone


def norm_space(s: str) -> str:
    s = (s or "").replace("\u00a0", " ")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def split_chunks(text: str, max_chars: int = 520, overlap: int = 80):
    t = norm_space(text)
    if not t:
        return []
    parts = []
    i = 0
    n = len(t)
    while i < n:
        j = min(n, i + max_chars)
        # 尽量在标点/换行处截断
        window = t[i:j]
        cut = max(window.rfind("。"), window.rfind("！"), window.rfind("？"), window.rfind("\n"))
        if cut >= int(max_chars * 0.55):
            j = i + cut + 1
        chunk = t[i:j].strip()
        if chunk:
            parts.append(chunk)
        if j >= n:
            break
        i = max(0, j - overlap)
    return parts


def guess_source_kind(filename: str) -> str:
    name = filename
    if "教参" in name:
        return "教参"
    if "成长" in name or "日记" in name or "成长记" in name:
        return "成长记"
    return "资料"


def main():
    try:
        from pypdf import PdfReader
    except Exception as e:
        print("缺少依赖：pypdf。请先运行：python -m pip install -r tools/requirements.txt", file=sys.stderr)
        raise

    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    data_dir = os.path.join(repo_root, "data")
    out_dir = os.path.join(repo_root, "server", "knowledge")
    out_path = os.path.join(out_dir, "index.json")

    if not os.path.isdir(data_dir):
        raise RuntimeError(f"未找到 data 目录：{data_dir}")

    os.makedirs(out_dir, exist_ok=True)

    pdf_files = [
        os.path.join(data_dir, fn)
        for fn in os.listdir(data_dir)
        if fn.lower().endswith(".pdf")
    ]
    if not pdf_files:
        raise RuntimeError("data/ 目录下未找到 PDF 文件。")

    chunks = []
    docs = []

    for pdf_path in pdf_files:
        filename = os.path.basename(pdf_path)
        source_kind = guess_source_kind(filename)
        priority = 2 if source_kind == "教参" else 1

        reader = PdfReader(pdf_path)
        num_pages = len(reader.pages)
        docs.append(
            {
                "filename": filename,
                "sourceKind": source_kind,
                "priority": priority,
                "pages": num_pages,
            }
        )

        for idx, page in enumerate(reader.pages):
            try:
                raw = page.extract_text() or ""
            except Exception:
                raw = ""
            raw = norm_space(raw)
            if not raw:
                continue

            for ci, chunk in enumerate(split_chunks(raw)):
                chunks.append(
                    {
                        "id": f"{filename}#p{idx+1}#c{ci+1}",
                        "sourceKind": source_kind,
                        "source": filename,
                        "priority": priority,
                        "page": idx + 1,
                        "text": chunk,
                    }
                )

    index = {
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "dataDir": "data",
        "docs": docs,
        "chunks": chunks,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    print(f"已生成知识库索引：{out_path}")
    print(f"文档数：{len(docs)}，片段数：{len(chunks)}")
    for d in docs:
        print(f"- {d['filename']} ({d['sourceKind']}, pages={d['pages']}, priority={d['priority']})")


if __name__ == "__main__":
    main()

