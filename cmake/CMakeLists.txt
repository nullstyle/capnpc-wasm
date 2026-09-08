cmake_minimum_required(VERSION 3.24)
project(capnpc_wasm_tools LANGUAGES C CXX)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "WASI")
  message(FATAL_ERROR "Use WASI SDK's wasi-sdk-p1.cmake toolchain")
endif()
if(NOT CMAKE_CXX_COMPILER_TARGET STREQUAL "wasm32-wasip1")
  message(FATAL_ERROR "Only single-threaded wasm32-wasip1 commands are supported")
endif()
set(CAPNP_SOURCE_DIR "" CACHE PATH "Patched disposable Cap'n Proto source checkout")
if(NOT EXISTS "${CAPNP_SOURCE_DIR}/c++/src/capnp/compiler/capnp.c++")
  message(FATAL_ERROR "CAPNP_SOURCE_DIR must contain the patched upstream source")
endif()
set(src "${CAPNP_SOURCE_DIR}/c++/src")
file(STRINGS "${CAPNP_SOURCE_DIR}/c++/CMakeLists.txt" capnp_version_definition
  REGEX "^set\\(VERSION " LIMIT_COUNT 1)
if(NOT capnp_version_definition MATCHES "^set\\(VERSION ([^ )]+)\\)$")
  message(FATAL_ERROR "Could not read VERSION from the pinned Cap'n Proto CMakeLists.txt")
endif()
set(capnp_version "${CMAKE_MATCH_1}")
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
# Cap'n Proto 2 requires exceptions. SDK 34 supplies libc++ and libunwind
# built with standardized Wasm EH. Its legacy EH and LTO paths are unsupported.
set(CMAKE_INTERPROCEDURAL_OPTIMIZATION OFF)
add_compile_options(-fwasm-exceptions -mllvm -wasm-use-legacy-eh=false -fno-rtti)
add_compile_definitions(KJ_NO_RTTI=1 KJ_HAS_LIBDL=0)
add_link_options(-fwasm-exceptions -Wl,-z,stack-size=8388608)
link_libraries(unwind)

set(kj_sources
  array list common debug exception io memory mutex string source-location
  glob-filter hash table main arena units encoding refcount string-tree time
  filesystem filesystem-disk-unix parse/char)
list(TRANSFORM kj_sources PREPEND "${src}/kj/")
list(TRANSFORM kj_sources APPEND ".c++")
add_library(kj STATIC ${kj_sources})
target_include_directories(kj PUBLIC "${src}")

set(capnp_sources
  c++.capnp blob arena layout list any message schema.capnp stream.capnp
  serialize serialize-packed schema schema-loader dynamic stringify)
list(TRANSFORM capnp_sources PREPEND "${src}/capnp/")
list(TRANSFORM capnp_sources APPEND ".c++")
add_library(capnp STATIC ${capnp_sources})
target_link_libraries(capnp PUBLIC kj)

set(capnpc_sources
  compiler/type-id compiler/error-reporter compiler/lexer.capnp compiler/lexer
  compiler/grammar.capnp compiler/parser compiler/generics compiler/node-translator
  compiler/compiler schema-parser serialize-text)
list(TRANSFORM capnpc_sources PREPEND "${src}/capnp/")
list(TRANSFORM capnpc_sources APPEND ".c++")
add_library(capnpc STATIC ${capnpc_sources})
target_link_libraries(capnpc PUBLIC capnp)

add_library(capnp_json STATIC "${src}/capnp/compat/json.c++" "${src}/capnp/compat/json.capnp.c++")
target_link_libraries(capnp_json PUBLIC capnp)

add_executable(capnp_tool "${src}/capnp/compiler/module-loader.c++" "${src}/capnp/compiler/capnp.c++")
target_link_libraries(capnp_tool PRIVATE capnpc capnp_json)
target_compile_definitions(capnp_tool PRIVATE CAPNP_INCLUDE_DIR="/include")
set_target_properties(capnp_tool PROPERTIES OUTPUT_NAME capnp SUFFIX .wasm)

add_executable(capnpc_cpp "${src}/capnp/compiler/capnpc-c++.c++")
target_link_libraries(capnpc_cpp PRIVATE capnp)
set_target_properties(capnpc_cpp PROPERTIES OUTPUT_NAME capnpc-c++ SUFFIX .wasm)

add_executable(capnpc_capnp "${src}/capnp/compiler/capnpc-capnp.c++")
target_link_libraries(capnpc_capnp PRIVATE capnp)
set_target_properties(capnpc_capnp PROPERTIES OUTPUT_NAME capnpc-capnp SUFFIX .wasm)

foreach(tool capnp_tool capnpc_cpp capnpc_capnp)
  target_compile_definitions(${tool} PRIVATE "VERSION=\"${capnp_version}\"")
endforeach()

install(TARGETS capnp_tool capnpc_cpp capnpc_capnp RUNTIME DESTINATION .)
