package fixture

import (
	"testing"

	"capnp-wasm/fixture/types"
	"capnproto.org/go/capnp/v3"
)

func TestGeneratedPersonRoundtrip(t *testing.T) {
	const id uint64 = 0xfedcba9876543210
	message, segment, err := capnp.NewMessage(capnp.SingleSegment(nil))
	if err != nil {
		t.Fatal(err)
	}
	defer message.Release()
	person, err := NewRootPerson(segment)
	if err != nil {
		t.Fatal(err)
	}
	if person.Which() != Person_Which_absent {
		t.Fatalf("default union arm = %v, want absent", person.Which())
	}
	person.SetId(id)
	if err := person.SetName("Zoë 🦀"); err != nil {
		t.Fatal(err)
	}
	if err := person.SetEmail("zoë@example.test"); err != nil {
		t.Fatal(err)
	}
	addresses, err := person.NewAddresses(1)
	if err != nil {
		t.Fatal(err)
	}
	if err := addresses.At(0).SetCity("Tromsø"); err != nil {
		t.Fatal(err)
	}
	// Leave the status and country unset to exercise schema defaults.
	data, err := message.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := capnp.Unmarshal(data)
	if err != nil {
		t.Fatal(err)
	}
	defer decoded.Release()
	got, err := ReadRootPerson(decoded)
	if err != nil {
		t.Fatal(err)
	}
	if got.Id() != id {
		t.Errorf("id = %#x, want %#x", got.Id(), id)
	}
	if name, err := got.Name(); err != nil || name != "Zoë 🦀" {
		t.Errorf("name = %q, error = %v", name, err)
	}
	if got.Status() != types.Status_active {
		t.Errorf("status = %v, want active", got.Status())
	}
	gotAddresses, err := got.Addresses()
	if err != nil {
		t.Fatal(err)
	}
	if gotAddresses.Len() != 1 {
		t.Fatalf("address count = %d, want 1", gotAddresses.Len())
	}
	if city, err := gotAddresses.At(0).City(); err != nil || city != "Tromsø" {
		t.Errorf("city = %q, error = %v", city, err)
	}
	if country, err := gotAddresses.At(0).Country(); err != nil || country != "US" {
		t.Errorf("country = %q, error = %v", country, err)
	}
	if got.Which() != Person_Which_email {
		t.Fatalf("union arm = %v, want email", got.Which())
	}
	if email, err := got.Email(); err != nil || email != "zoë@example.test" {
		t.Errorf("email = %q, error = %v", email, err)
	}
}
