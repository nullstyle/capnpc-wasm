@0xea3541fcb9cb2a27;
using Missing = import "not-here.capnp";
struct Broken {
  field @0 :Missing.Type;
}
