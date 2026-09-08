// Test-only normalization for map-like lists whose hash iteration order can
// differ between native and wasm32 builds. All other ordering remains intact.
#include <capnp/message.h>
#include <capnp/schema.capnp.h>
#include <capnp/serialize.h>
#include <kj/debug.h>
#include <kj/exception.h>
#include <kj/io.h>
#include <kj/string.h>

#include <algorithm>
#include <numeric>
#include <vector>

template <typename Element>
void copySortedById(typename capnp::List<Element>::Reader input,
                    typename capnp::List<Element>::Builder output) {
  std::vector<unsigned int> order(input.size());
  std::iota(order.begin(), order.end(), 0u);
  std::stable_sort(order.begin(), order.end(), [&](auto left, auto right) {
    return input[left].getId() < input[right].getId();
  });
  for (unsigned int i = 0; i < input.size(); ++i) {
    output.setWithCaveats(i, input[order[i]]);
  }
}

int main() {
  KJ_IF_SOME(exception, kj::runCatchingExceptions([] {
    kj::FdInputStream stream(0);
    kj::Array<capnp::word> words;
    {
      capnp::InputStreamMessageReader input(stream);
      auto request = input.getRoot<capnp::schema::CodeGeneratorRequest>();
      capnp::MallocMessageBuilder normalized;
      normalized.setRoot(request);
      auto result = normalized.getRoot<capnp::schema::CodeGeneratorRequest>();

      // Copy from the original reader so permutation cannot overwrite its source.
      // Reuse the copied lists' element layouts, preserving even unknown fields;
      // allocating fresh typed lists could truncate them via setWithCaveats().
      // Preserve absent and empty lists without changing their pointers.
      auto nodes = request.getNodes();
      if (nodes.size() > 1) {
        copySortedById<capnp::schema::Node>(nodes, result.getNodes());
      }
      auto sourceInfo = request.getSourceInfo();
      if (sourceInfo.size() > 1) {
        copySortedById<capnp::schema::Node::SourceInfo>(
            sourceInfo, result.getSourceInfo());
      }

      // Canonicalize the full binary graph, including AnyPointer defaults. The
      // output is a canonical flat segment without a stream framing table.
      words = capnp::canonicalize(result.asReader());
    }

    // Reader destruction consumes any lazily unread segment bytes. Require EOF
    // before output so appended diagnostics or another request cannot pass parity.
    kj::byte trailing;
    KJ_REQUIRE(stream.tryRead(kj::arrayPtr(&trailing, 1), 1) == 0,
               "trailing bytes after CodeGeneratorRequest");
    kj::FdOutputStream(1).write(words.asBytes());
  })) {
    kj::FdOutputStream(2).write(kj::str(exception, '\n').asBytes());
    return 1;
  }
  return 0;
}
