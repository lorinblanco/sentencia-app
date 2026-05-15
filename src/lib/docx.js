import { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel } from 'docx'
import { saveAs } from 'file-saver'

const J = AlignmentType.JUSTIFIED
const C = AlignmentType.CENTER

function t(text, opts = {}) {
  return new TextRun({ text, font: 'Times New Roman', size: 24, ...opts })
}
function b(text) { return t(text, { bold: true }) }

function para(children, align = J, spaceBefore = 0, spaceAfter = 6, firstLine = 720) {
  return new Paragraph({
    alignment: align,
    spacing: { before: spaceBefore, after: spaceAfter * 20, line: 276 },
    indent: align !== C && firstLine > 0 ? { firstLine } : undefined,
    children,
  })
}

function blank() {
  return new Paragraph({ spacing: { before: 0, after: 80 }, children: [t('')] })
}

function processLine(line) {
  const children = []
  // Bold text between ** **
  const parts = line.split(/(\*\*[^*]+\*\*)/g)
  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**')) {
      children.push(b(part.slice(2, -2)))
    } else if (part) {
      children.push(t(part))
    }
  }
  return children
}

const HEADINGS = [
  'PRIMERA CUESTIÓN',
  'SEGUNDA CUESTIÓN',
  'A LA PRIMERA CUESTIÓN',
  'A LA SEGUNDA CUESTIÓN',
  'A LA PRIMERA CUESTION',
  'A LA SEGUNDA CUESTION',
  'AUTOS Y VISTO',
]

const CENTER_LINES = ['S  E  N  T  E  N  C  I  A', 'SENTENCIA']

export async function generateWordDoc(sentenceText, filename) {
  const lines = sentenceText.split('\n')
  const docChildren = []

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (!line) {
      docChildren.push(blank())
      continue
    }

    const isCenter = CENTER_LINES.some(c => line.includes(c))
    const isHeading = HEADINGS.some(h => line.startsWith(h))
    const isTab = rawLine.startsWith('\t')

    if (isCenter) {
      docChildren.push(para([b(line)], C, 200, 200, 0))
      continue
    }

    if (isHeading) {
      docChildren.push(para([b(line)], J, 160, 80, 0))
      continue
    }

    if (line.startsWith('ARTÍCULO 54') || line.startsWith('"ARTÍCULO 54')) {
      // Render in smaller text for the full article
      docChildren.push(para([t(line, { size: 22 })], J, 100, 60, 360))
      continue
    }

    const children = processLine(line)
    const firstIndent = isTab ? 0 : 720
    docChildren.push(para(children, J, 0, 60, firstIndent))
  }

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: 'Times New Roman', size: 24 } },
      },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 }, // A4
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1800 },
        },
      },
      children: docChildren,
    }],
  })

  const buffer = await Packer.toBuffer(doc)
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
  saveAs(blob, filename || 'sentencia.docx')
  return blob
}
