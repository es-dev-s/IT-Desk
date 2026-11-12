package domain

import "testing"

func TestMemberInputValidate(t *testing.T) {
	seat := " seat_b4 "
	in := MemberInput{Name: "  Asha   Rai ", Designation: "QA Engineer", TeamID: "t1", SeatID: &seat,
		Devices: []DeviceInput{{Kind: "Laptop", Model: "ThinkPad X1", AssetTag: "it-lp-0142"}}}
	in.Normalize()
	if in.Name != "Asha Rai" || *in.SeatID != "seat_b4" || in.SubGroup != "General" || in.Devices[0].AssetTag != "IT-LP-0142" || in.Devices[0].Kind != "laptop" {
		t.Fatalf("normalize: %+v", in)
	}
	if errs := in.Validate(); len(errs) != 0 {
		t.Fatalf("valid input rejected: %v", errs)
	}

	bad := MemberInput{Name: "A", EmployeeID: "-x", Email: "nope", Designation: "", TeamID: "",
		Devices: []DeviceInput{{Kind: "toaster", Model: "", AssetTag: "LP-1"}, {Kind: "mouse", Model: "MX", AssetTag: "IT-MS-0001"}, {Kind: "mouse", Model: "MX", AssetTag: "IT-MS-0001"}}}
	bad.Normalize()
	errs := bad.Validate()
	for _, k := range []string{"name", "employeeId", "email", "designation", "teamId", "devices.0.kind", "devices.0.model", "devices.0.assetTag", "devices.2.assetTag"} {
		if _, ok := errs[k]; !ok {
			t.Errorf("expected error for %s (got %v)", k, errs)
		}
	}
	if _, ok := errs["devices.1.assetTag"]; ok {
		t.Error("first use of a tag flagged as duplicate")
	}
	// Email and employee ID are optional.
	opt := MemberInput{Name: "No Email", Designation: "Analyst", TeamID: "t1"}
	opt.Normalize()
	if errs := opt.Validate(); len(errs) != 0 {
		t.Fatalf("optional fields rejected: %v", errs)
	}
	if HueFor("Asha Rai") != HueFor("asha rai") || HueFor("x") < 0 || HueFor("x") > 359 {
		t.Error("hue not stable / in range")
	}
}
