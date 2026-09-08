#include "values.capnp.h"
#include <capnp/message.h>
#include <capnp/serialize.h>
#include <cassert>
#include <cstdint>
#include <limits>
#include <string>

void checkDefaults(feature_test::Values::Reader value) {
  const auto raw = value.getRaw();
  assert(raw.size() == 256);
  for (unsigned i = 0; i < raw.size(); ++i) assert(raw[i] == i);
  assert(value.getText() == "Embedded text: café, Tromsø, 🦀.\nSecond line.\n");
  const auto data = value.getInlineData();
  assert(data.size() == 5 && data[0] == 0 && data[1] == 127 &&
         data[2] == 128 && data[3] == 255 && data[4] == 0);
  const char expected[] = "NUL:\0; café 🦀\n";
  const auto text = value.getInlineText();
  assert(std::string(text.begin(), text.size()) ==
         std::string(expected, sizeof(expected) - 1));
  assert(value.getHigh() == std::numeric_limits<uint64_t>::max());
  assert(value.getLow() == std::numeric_limits<int64_t>::min());
  assert(value.getHighSigned() == std::numeric_limits<int64_t>::max());
  const auto numbers = value.getNumbers();
  assert(numbers.size() == 3 && numbers[0] == 0 &&
         numbers[1] == (uint64_t{1} << 63) &&
         numbers[2] == std::numeric_limits<uint64_t>::max());
  assert(value.getRecord().getLabel() == "constant é");
  assert(value.getRecord().getMode() == feature_test::Record::Mode::ACTIVE);
  assert(value.getRecords().size() == 2);
  assert(value.getRecords()[1].getLabel() == "default 🦀");
  assert(value.getDetails().getEnabled());
  assert(value.getDetails().getMode() == feature_test::Record::Mode::ARCHIVED);
  assert(value.getTagged() == "tagged");
}

int main() {
  capnp::MallocMessageBuilder message;
  auto value = message.initRoot<feature_test::Values>();
  checkDefaults(value.asReader());
  assert(value.isNone());
  value.initSelected().setName("selected 🦀");
  auto words = capnp::messageToFlatArray(message);
  capnp::FlatArrayMessageReader decoded(words);
  auto result = decoded.getRoot<feature_test::Values>();
  checkDefaults(result);
  assert(result.isSelected());
  assert(result.getSelected().getName() == "selected 🦀");
}
