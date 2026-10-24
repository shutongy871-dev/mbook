"""Download verified CC0 packs with bounded range requests; no platform music."""
import concurrent.futures
import pathlib
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1] / ".artifacts" / "audio"
PACKS = {
    "calm": "https://opengameart.org/sites/default/files/JRPG%20Music%20Pack%20%234%20%5BCalm%5D%20by%20Juhani%20Junkala_0.zip",
    "dramatic": "https://opengameart.org/sites/default/files/Alexander%20Ehlers%20-%20Free%20Music%20Pack.zip",
}


def fetch_pack(name, url):
    ROOT.mkdir(parents=True, exist_ok=True)
    target = ROOT / (name + ".zip")
    with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=20) as response:
        total = int(response.headers["Content-Length"])
    current = target.stat().st_size if target.exists() else 0
    if current > total:
        raise ValueError("Unexpected existing file size")
    chunk_size = 512 * 1024
    spans = [(start, min(start + chunk_size, total) - 1) for start in range(current, total, chunk_size)]

    def fetch_span(span):
        start, end = span
        request = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=40) as response:
                    if response.status != 206:
                        raise ValueError("Server ignored Range")
                    data = response.read()
                if len(data) != end - start + 1:
                    raise ValueError("Incomplete range")
                return start, data
            except Exception:
                if attempt == 2:
                    raise
        raise RuntimeError("Unreachable")

    # Network I/O only; no tool calls or unbounded connection creation.
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        pieces = list(pool.map(fetch_span, spans))
    with target.open("ab") as output:
        for _, data in sorted(pieces):
            output.write(data)
    with zipfile.ZipFile(target) as archive:
        if archive.testzip() is not None:
            raise ValueError("ZIP CRC failed")
        for name_in_zip in archive.namelist():
            path = pathlib.PurePosixPath(name_in_zip)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError("Unsafe archive path")
            archive.extract(name_in_zip, ROOT / name)
            print(name_in_zip, flush=True)


if __name__ == "__main__":
    import sys
    name = sys.argv[1]
    fetch_pack(name, PACKS[name])
