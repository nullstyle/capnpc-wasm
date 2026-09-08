@0xf3d432fd6f24c6f1;

using Cxx = import "/capnp/c++.capnp";
$Cxx.namespace("fixture");

enum Status {
  pending @0;
  active @1;
  retired @2;
}

struct Address {
  city @0 :Text;
  country @1 :Text = "US";
}
