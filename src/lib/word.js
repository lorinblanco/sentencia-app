import { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel } from 'docx'
import { saveAs } from 'file-saver'

const J = AlignmentType.JUSTIFIED
const C = AlignmentType.CENTER
const sp = { before: 80, after: 80, line: 280 }

function para(text, { bold = false, center = false, size = 24, indent = true } = {}) {
  return new Paragraph({
    alignment: center ? C : J,
    spacing: sp,
    indent: indent && !center ? { firstLine: 720 } : {},
    children: [new TextRun({ text: text || '', font: 'Times New Roman', size, bold })]
  })
}

function blank() {
  return new Paragraph({ spacing: { before: 60, after: 60 }, children: [new TextRun('')] })
}

function heading(text) {
  return para(text, { bold: true, indent: false })
}

function center(text, bold = false) {
  return para(text, { bold, center: true, indent: false })
}

export async function buildWordDocument(sentenceText, caratula, causaNumero) {
  const lines = sentenceText.split('\n')
  const children = []

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { children.push(blank()); continue }

    const isHeading = [
      'PRIMERA CUESTIÓN', 'SEGUNDA CUESTIÓN',
      'A LA PRIMERA CUESTIÓN', 'A LA SEGUNDA CUESTIÓN',
      'A LA PRIMERA CUESTION', 'A LA SEGUNDA CUESTION',
      'AUTOS Y VISTO',
    ].some(h => line.startsWith(h))

    const isCenter = line.includes('S  E  N  T  E  N  C  I  A') ||
      line.startsWith('En la ciudad de Quilmes, se reúnen')

    if (isCenter && line.includes('S  E  N  T  E  N  C  I  A')) {
      children.push(blank())
      children.push(center(line, true))
      children.push(blank())
    } else if (isHeading) {
      children.push(blank())
      children.push(heading(line))
      children.push(blank())
    } else {
      children.push(para(line, { bold: false, center: isCenter, indent: !isCenter }))
    }
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Times New Roman', size: 24 } } } },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1800 }
        }
      },
      children
    }]
  })

  const blob = await Packer.toBlob(doc)
  const safeName = causaNumero?.replace(/\./g, '') || 'sentencia'
  saveAs(blob, `SentencIA_${safeName}.docx`)
  return blob
}
