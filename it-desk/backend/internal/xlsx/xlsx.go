// Package xlsx writes a minimal single-sheet Excel workbook (.xlsx) with the
// standard library only: a bold, frozen header row with a filter, text cells
// and column widths. Enough for the report exports; not a general library.
package xlsx

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

// Sheet is one worksheet: Headers is the first row, Rows the data.
type Sheet struct {
	Name    string
	Headers []string
	Rows    [][]string
	// Widths are column widths in characters (optional; sized from content when empty).
	Widths []float64
}

const (
	contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
	rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
	workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
	// Style 0: text, wrapped, top-aligned. Style 1: bold header on a grey fill.
	styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7E5E4"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFA8A29E"/></left><right style="thin"><color rgb="FFA8A29E"/></right><top style="thin"><color rgb="FFA8A29E"/></top><bottom style="thin"><color rgb="FFA8A29E"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="49" fontId="1" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs></styleSheet>`
)

// Write encodes the sheet as an .xlsx file.
func Write(w io.Writer, s Sheet) error {
	zw := zip.NewWriter(w)
	name := sheetName(s.Name)
	parts := []struct{ path, body string }{
		{"[Content_Types].xml", contentTypes},
		{"_rels/.rels", rootRels},
		{"xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="` + escape(name) + `" sheetId="1" r:id="rId1"/></sheets></workbook>`},
		{"xl/_rels/workbook.xml.rels", workbookRels},
		{"xl/styles.xml", styles},
		{"xl/worksheets/sheet1.xml", sheetXML(s)},
	}
	for _, p := range parts {
		f, err := zw.Create(p.path)
		if err != nil {
			return err
		}
		if _, err := io.WriteString(f, p.body); err != nil {
			return err
		}
	}
	return zw.Close()
}

// Bytes is Write into memory.
func Bytes(s Sheet) ([]byte, error) {
	var b bytes.Buffer
	if err := Write(&b, s); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

func sheetXML(s Sheet) string {
	cols := len(s.Headers)
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`)
	if cols > 0 {
		b.WriteString("<cols>")
		for i := 0; i < cols; i++ {
			fmt.Fprintf(&b, `<col min="%d" max="%d" width="%.1f" customWidth="1"/>`, i+1, i+1, width(s, i))
		}
		b.WriteString("</cols>")
	}
	b.WriteString("<sheetData>")
	writeRow(&b, 1, s.Headers, cols, 1)
	for i, r := range s.Rows {
		writeRow(&b, i+2, r, cols, 0)
	}
	b.WriteString("</sheetData>")
	if cols > 0 {
		fmt.Fprintf(&b, `<autoFilter ref="A1:%s%d"/>`, colName(cols-1), len(s.Rows)+1)
	}
	b.WriteString("</worksheet>")
	return b.String()
}

func writeRow(b *strings.Builder, n int, cells []string, cols, style int) {
	fmt.Fprintf(b, `<row r="%d">`, n)
	for i := 0; i < cols; i++ {
		v := ""
		if i < len(cells) {
			v = cells[i]
		}
		fmt.Fprintf(b, `<c r="%s%d" s="%d" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>`, colName(i), n, style, escape(v))
	}
	b.WriteString("</row>")
}

// width sizes a column from its longest line, between 10 and 60 characters.
func width(s Sheet, col int) float64 {
	if col < len(s.Widths) && s.Widths[col] > 0 {
		return s.Widths[col]
	}
	longest := utf8.RuneCountInString(s.Headers[col])
	for _, r := range s.Rows {
		if col >= len(r) {
			continue
		}
		for _, line := range strings.Split(r[col], "\n") {
			if n := utf8.RuneCountInString(line); n > longest {
				longest = n
			}
		}
	}
	return float64(min(max(longest+2, 10), 60))
}

// colName: 0 -> A, 25 -> Z, 26 -> AA.
func colName(i int) string {
	name := ""
	for i >= 0 {
		name = string(rune('A'+i%26)) + name
		i = i/26 - 1
	}
	return name
}

// escape makes text safe inside XML and drops characters XML 1.0 can't hold.
func escape(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '&':
			b.WriteString("&amp;")
		case r == '<':
			b.WriteString("&lt;")
		case r == '>':
			b.WriteString("&gt;")
		case r == '"':
			b.WriteString("&quot;")
		case r == '\n' || r == '\t':
			b.WriteRune(r)
		case r < 0x20 || r == 0xFFFE || r == 0xFFFF || r == utf8.RuneError:
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// sheetName: Excel allows 31 characters and none of : \ / ? * [ ].
func sheetName(s string) string {
	s = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`:\/?*[]`, r) {
			return ' '
		}
		return r
	}, strings.TrimSpace(s))
	if s == "" {
		return "Report"
	}
	if r := []rune(s); len(r) > 31 {
		s = string(r[:31])
	}
	return s
}
