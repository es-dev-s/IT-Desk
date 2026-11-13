package xlsx

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"io"
	"strings"
	"testing"
)

func TestWriteIsAReadableWorkbook(t *testing.T) {
	data, err := Bytes(Sheet{
		Name:    "Members/devices: all",
		Headers: []string{"Member Name (ID)", "Seat Number", "Device"},
		Rows: [][]string{
			{"Ann <Lee> & co (E-1)", "12", "Laptop \"X1\"\nIT-LP-0001"},
			{"Bo\x01 Chen", ""}, // short row, control character
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		files[f.Name] = string(b)
		// Every part must be well-formed XML.
		d := xml.NewDecoder(bytes.NewReader(b))
		for {
			if _, err := d.Token(); err == io.EOF {
				break
			} else if err != nil {
				t.Fatalf("%s is not well-formed: %v", f.Name, err)
			}
		}
	}
	for _, name := range []string{"[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"} {
		if files[name] == "" {
			t.Errorf("missing part %s", name)
		}
	}
	sheet := files["xl/worksheets/sheet1.xml"]
	for _, want := range []string{"Ann &lt;Lee&gt; &amp; co (E-1)", `<c r="C2"`, `<row r="3">`, `<c r="C3"`, `autoFilter ref="A1:C3"`, "Bo Chen", `state="frozen"`} {
		if !strings.Contains(sheet, want) {
			t.Errorf("sheet lacks %q", want)
		}
	}
	if !strings.Contains(files["xl/workbook.xml"], `name="Members devices  all"`) {
		t.Errorf("sheet name not sanitised: %s", files["xl/workbook.xml"])
	}
	if got := []string{colName(0), colName(25), colName(26), colName(27), colName(701), colName(702)}; strings.Join(got, ",") != "A,Z,AA,AB,ZZ,AAA" {
		t.Errorf("column names: %v", got)
	}
}
