"""A4-05 读取资料正文：把已通过核对的上传文件转成纯文本，供 B 的需求提取等功能使用。

边界（V1）：
- 只读取上传凭证已经 completed 的文件，并且先核对内容的 SHA-256 与凭证记录一致；
- 支持 .md、.txt（UTF-8）、.pdf（有文字层的）、.docx；旧版 .doc/.ppt/.xls 明确返回不支持；
- 加密 PDF、损坏文件、无法解码的文本都返回明确错误，不返回空正文冒充成功；
- 正文超过上限会截断，并在结果里标明 truncated=True；
- 结果不写数据库，由调用方决定如何使用。
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass
from uuid import UUID

import docx
from pypdf import PdfReader
from pypdf.errors import PdfReadError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.modules.a import storage
from app.modules.a.models import UploadReceipt as UploadReceiptRow

MAX_TEXT_CHARS = 200_000
MAX_PDF_PAGES = 300
TEXT_EXTENSIONS = {"md", "txt"}
SUPPORTED_EXTENSIONS = TEXT_EXTENSIONS | {"pdf", "docx"}


@dataclass(frozen=True)
class ExtractedText:
    text: str
    format: str
    truncated: bool
    char_count: int


def _unsupported() -> ApiError:
    return ApiError(
        422,
        "TEXT_EXTRACTION_UNSUPPORTED",
        "这种文件暂不支持读取正文，请转换为 PDF、DOCX、MD 或 TXT 后再上传。",
    )


def _finish(text: str, fmt: str) -> ExtractedText:
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    truncated = len(text) > MAX_TEXT_CHARS
    if truncated:
        text = text[:MAX_TEXT_CHARS]
    return ExtractedText(text=text, format=fmt, truncated=truncated, char_count=len(text))


def extract_text(data: bytes, extension: str) -> ExtractedText:
    """把文件内容转成纯文本。extension 为不带点的小写扩展名。"""
    extension = extension.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise _unsupported()
    if extension in TEXT_EXTENSIONS:
        return _extract_plain(data, extension)
    if extension == "pdf":
        return _extract_pdf(data)
    return _extract_docx(data)


def _extract_plain(data: bytes, fmt: str) -> ExtractedText:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ApiError(
            422, "TEXT_DECODE_FAILED", "文本文件不是 UTF-8 编码，请另存为 UTF-8 后再上传。"
        ) from exc
    return _finish(text, fmt)


def _extract_pdf(data: bytes) -> ExtractedText:
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise ApiError(422, "PDF_ENCRYPTED", "这个 PDF 有密码保护，无法读取正文。")
        if len(reader.pages) > MAX_PDF_PAGES:
            raise ApiError(
                422, "PDF_TOO_MANY_PAGES", f"PDF 超过 {MAX_PDF_PAGES} 页，请拆分后再上传。"
            )
        parts = [(page.extract_text() or "") for page in reader.pages]
    except ApiError:
        raise
    except (PdfReadError, ValueError, KeyError, IndexError, TypeError) as exc:
        raise ApiError(422, "TEXT_EXTRACTION_FAILED", "无法读取这个 PDF，文件可能已损坏。") from exc
    # 没有文字层（扫描件）时返回空正文，由调用方提示人工处理，而不是假装读到了内容。
    return _finish("\n\n".join(parts), "pdf")


def _extract_docx(data: bytes) -> ExtractedText:
    try:
        document = docx.Document(io.BytesIO(data))
        parts = [p.text for p in document.paragraphs]
        for table in document.tables:
            for row in table.rows:
                parts.append("\t".join(cell.text for cell in row.cells))
    except Exception as exc:  # python-docx 对损坏文件会抛出多种异常
        raise ApiError(
            422, "TEXT_EXTRACTION_FAILED", "无法读取这个 Word 文件，文件可能已损坏。"
        ) from exc
    return _finish("\n".join(parts), "docx")


def read_receipt_text(
    session: Session,
    user: User,
    receipt_id: UUID,
    *,
    client: storage.StorageClient | None = None,
) -> ExtractedText:
    """读取一个已完成上传的文件正文。只允许上传者本人读取，并且重新核对指纹。"""
    row = session.scalar(
        select(UploadReceiptRow).where(
            UploadReceiptRow.id == receipt_id,
            UploadReceiptRow.actor_id == user.id,
        )
    )
    if row is None or row.status != "completed" or not row.content_hash:
        raise ApiError(404, "UPLOAD_NOT_FOUND", "上传记录不存在或尚未完成。")
    # 读取正文同样要求仍然有该资料所在项目或课程的访问权限。
    storage._authorize_upload(session, user, row.scope, row.scope_id)

    storage_client = storage._require_client(
        client if client is not None else storage.get_storage_client()
    )
    try:
        data = storage_client.download(row.object_id, max_bytes=storage.MAX_FILE_BYTES)
    except FileNotFoundError as exc:
        raise ApiError(409, "UPLOAD_NOT_RECEIVED", "文件暂时找不到，请重新上传。") from exc

    if hashlib.sha256(data).hexdigest() != row.content_hash:
        raise ApiError(409, "UPLOAD_CONTENT_MISMATCH", "文件内容与上传记录不一致，请重新上传。")

    extension = storage._extension(row.filename)
    return extract_text(data, extension)
