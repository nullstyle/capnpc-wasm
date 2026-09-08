@0xebc4be2ed783c7dd;

struct ListRoot {
  items @0 :List(Item);
}

struct Item {
  value @0 :UInt64;
}

struct PointerListRoot {
  items @0 :List(PointerItem);
}

struct PointerItem {
  value @0 :UInt64;
  text @1 :Text;
}

struct EmptyListRoot {
  items @0 :List(EmptyItem);
}

struct EmptyItem {}

struct TextRoot {
  text @0 :Text;
}

struct Node {
  child @0 :Node;
  value @1 :UInt64;
}
