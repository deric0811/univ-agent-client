import { PDFDocument } from "pdf-lib";

/**
 * 여러 PDF 바이트 버퍼를 순서대로 하나의 PDF로 무손실 병합합니다.
 * 페이지 객체를 복사해 붙이므로 원본 문서의 내용과 레이아웃이 유지됩니다.
 */
export async function mergePdfFiles(pdfArrayBuffers: Uint8Array[]): Promise<Uint8Array> {
  if (pdfArrayBuffers.length === 0) {
    throw new Error("병합할 PDF 파일이 없습니다.");
  }

  const merged = await PDFDocument.create();
  for (const buffer of pdfArrayBuffers) {
    const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) {
      merged.addPage(page);
    }
  }
  return merged.save();
}