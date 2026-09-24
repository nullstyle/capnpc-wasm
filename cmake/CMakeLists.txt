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
set(CAPNP_PORT_PATCH "" CACHE FILEPATH
  "The port patch applied to CAPNP_SOURCE_DIR; the translation units it touches compile with -Werror")
set(CAPNP_UNSTRIPPED_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/unstripped" CACHE PATH
  "Directory for the module copies that keep the sysroot's DWARF sections")
set(src "${CAPNP_SOURCE_DIR}/c++/src")
file(STRINGS "${CAPNP_SOURCE_DIR}/c++/CMakeLists.txt" capnp_version_definition
  REGEX "^set\\(VERSION " LIMIT_COUNT 1)
if(NOT capnp_version_definition MATCHES "^set\\(VERSION ([^ )]+)\\)$")
  message(FATAL_ERROR "Could not read VERSION from the pinned Cap'n Proto CMakeLists.txt")
endif()
set(capnp_version "${CMAKE_MATCH_1}")
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Upstream refuses to build without compiler extensions (c++/CMakeLists.txt)
# and the native oracle compiles as gnu++23; the port uses the same language
# mode so wasi-libc exposes the same declarations to both.
set(CMAKE_CXX_EXTENSIONS ON)
# Cap'n Proto 2 requires exceptions. SDK 34 supplies libc++ and libunwind
# built with standardized Wasm EH. Its legacy EH and LTO paths are unsupported.
set(CMAKE_INTERPROCEDURAL_OPTIMIZATION OFF)

# Source lists are copied from upstream's kj and capnp CMakeLists.txt. They are
# compared with those files at configure time, so a reference bump that adds or
# renames a unit fails here instead of at link time, and the exclusions below
# stay deliberate.
function(capnp_upstream_sources out_var cmake_file)
  # Collects the entries of the set(<name> ...) lists named in ARGN.
  file(READ "${cmake_file}" content)
  set(result)
  foreach(name IN LISTS ARGN)
    if(NOT content MATCHES "set\\(${name}[ \t\r\n]+([^)]*)\\)")
      message(FATAL_ERROR "${cmake_file} no longer defines ${name}")
    endif()
    string(REGEX MATCHALL "[^ \t\r\n]+" entries "${CMAKE_MATCH_1}")
    list(APPEND result ${entries})
  endforeach()
  set(${out_var} "${result}" PARENT_SCOPE)
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${cmake_file}")
endfunction()

function(capnp_check_sources label project_sources upstream_sources excluded)
  # The project list plus the documented exclusions must equal upstream's list.
  set(missing ${upstream_sources})
  foreach(item IN LISTS project_sources excluded)
    list(REMOVE_ITEM missing "${item}")
  endforeach()
  set(unknown ${project_sources})
  set(stale ${excluded})
  foreach(item IN LISTS upstream_sources)
    list(REMOVE_ITEM unknown "${item}")
    list(REMOVE_ITEM stale "${item}")
  endforeach()
  if(missing OR unknown OR stale)
    message(FATAL_ERROR "${label} sources differ from upstream: "
      "upstream units not listed here [${missing}]; listed units upstream no longer has [${unknown}]; "
      "excluded units upstream no longer has [${stale}]")
  endif()
endfunction()

set(kj_sources
  array.c++ list.c++ common.c++ debug.c++ exception.c++ io.c++ memory.c++
  mutex.c++ string.c++ source-location.c++ glob-filter.c++ hash.c++ table.c++
  main.c++ arena.c++ units.c++ encoding.c++ refcount.c++ string-tree.c++
  time.c++ filesystem.c++ filesystem-disk-unix.c++ parse/char.c++)
# Not part of the port: the commands are single threaded, the Win32
# filesystem does not apply, and test-helpers serves only upstream's tests.
set(kj_excluded thread.c++ test-helpers.c++ filesystem-disk-win32.c++)
capnp_upstream_sources(kj_upstream "${src}/kj/CMakeLists.txt"
  kj_sources_lite kj_sources_heavy)
capnp_check_sources(kj "${kj_sources}" "${kj_upstream}" "${kj_excluded}")
list(TRANSFORM kj_sources PREPEND "${src}/kj/")
add_library(kj STATIC ${kj_sources})
target_include_directories(kj PUBLIC "${src}")
# Every target links kj, so its PUBLIC requirements carry the port's profile:
# standardized Wasm exceptions without RTTI, upstream's warning set, and
# source paths recorded relative to c++/src. kj already trims diagnostics to
# that form, so messages are unchanged, and the module bytes no longer depend
# on the checkout path.
target_compile_options(kj PUBLIC
  -fwasm-exceptions "SHELL:-mllvm -wasm-use-legacy-eh=false" -fno-rtti
  "-ffile-prefix-map=${src}/="
  -Wall -Wextra -Wsuggest-override -Wno-strict-aliasing -Wno-sign-compare
  -Wno-unused-parameter)
target_compile_definitions(kj PUBLIC KJ_NO_RTTI=1 KJ_HAS_LIBDL=0)
target_link_options(kj PUBLIC -fwasm-exceptions -Wl,-z,stack-size=8388608)
target_link_libraries(kj PUBLIC unwind)

set(capnp_sources
  c++.capnp.c++ blob.c++ arena.c++ layout.c++ list.c++ any.c++ message.c++
  schema.capnp.c++ stream.capnp.c++ serialize.c++ serialize-packed.c++
  schema.c++ schema-loader.c++ dynamic.c++ stringify.c++)
capnp_upstream_sources(capnp_upstream "${src}/capnp/CMakeLists.txt"
  capnp_sources_lite capnp_sources_heavy)
capnp_check_sources(capnp "${capnp_sources}" "${capnp_upstream}" "")
list(TRANSFORM capnp_sources PREPEND "${src}/capnp/")
add_library(capnp STATIC ${capnp_sources})
target_link_libraries(capnp PUBLIC kj)

set(capnpc_sources
  compiler/type-id.c++ compiler/error-reporter.c++ compiler/lexer.capnp.c++
  compiler/lexer.c++ compiler/grammar.capnp.c++ compiler/parser.c++
  compiler/generics.c++ compiler/node-translator.c++ compiler/compiler.c++
  schema-parser.c++ serialize-text.c++)
capnp_upstream_sources(capnpc_upstream "${src}/capnp/CMakeLists.txt" capnpc_sources)
capnp_check_sources(capnpc "${capnpc_sources}" "${capnpc_upstream}" "")
list(TRANSFORM capnpc_sources PREPEND "${src}/capnp/")
add_library(capnpc STATIC ${capnpc_sources})
target_link_libraries(capnpc PUBLIC capnp)

set(capnp_json_sources compat/json.c++ compat/json.capnp.c++)
capnp_upstream_sources(capnp_json_upstream "${src}/capnp/CMakeLists.txt" capnp-json_sources)
capnp_check_sources(capnp-json "${capnp_json_sources}" "${capnp_json_upstream}" "")
list(TRANSFORM capnp_json_sources PREPEND "${src}/capnp/")
add_library(capnp_json STATIC ${capnp_json_sources})
target_link_libraries(capnp_json PUBLIC capnp)

function(capnp_add_tool target name libraries)
  # Links one set of objects twice. The shipped module drops the DWARF sections
  # that the SDK sysroot's prebuilt libraries carry (its name section stays,
  # so traps are symbolized); the copy under CAPNP_UNSTRIPPED_OUTPUT_DIRECTORY
  # keeps them for debugging. ARGN lists the sources.
  add_library(${target}_objects OBJECT ${ARGN})
  target_link_libraries(${target}_objects PRIVATE ${libraries})
  foreach(executable IN ITEMS ${target} ${target}_unstripped)
    add_executable(${executable} $<TARGET_OBJECTS:${target}_objects>)
    target_link_libraries(${executable} PRIVATE ${libraries})
    set_target_properties(${executable} PROPERTIES OUTPUT_NAME ${name} SUFFIX .wasm)
  endforeach()
  target_link_options(${target} PRIVATE -Wl,--strip-debug)
  set_target_properties(${target}_unstripped PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CAPNP_UNSTRIPPED_OUTPUT_DIRECTORY}")
endfunction()

set(capnp_tool_sources
  "${src}/capnp/compiler/module-loader.c++" "${src}/capnp/compiler/capnp.c++")
set(capnpc_cpp_sources "${src}/capnp/compiler/capnpc-c++.c++")
set(capnpc_capnp_sources "${src}/capnp/compiler/capnpc-capnp.c++")
capnp_add_tool(capnp_tool capnp "capnpc;capnp_json" ${capnp_tool_sources})
target_compile_definitions(capnp_tool_objects PRIVATE CAPNP_INCLUDE_DIR="/include")
capnp_add_tool(capnpc_cpp capnpc-c++ capnp ${capnpc_cpp_sources})
capnp_add_tool(capnpc_capnp capnpc-capnp capnp ${capnpc_capnp_sources})
foreach(tool capnp_tool capnpc_cpp capnpc_capnp)
  target_compile_definitions(${tool}_objects PRIVATE "VERSION=\"${capnp_version}\"")
endforeach()

# Warnings in the translation units the port patches are errors; upstream's
# untouched units keep upstream's warning policy. The units are read from the
# patch so a new hunk is covered without editing this file.
if(CAPNP_PORT_PATCH)
  if(NOT EXISTS "${CAPNP_PORT_PATCH}")
    message(FATAL_ERROR "CAPNP_PORT_PATCH does not exist: ${CAPNP_PORT_PATCH}")
  endif()
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CAPNP_PORT_PATCH}")
  set(all_sources ${kj_sources} ${capnp_sources} ${capnpc_sources} ${capnp_json_sources}
    ${capnp_tool_sources} ${capnpc_cpp_sources} ${capnpc_capnp_sources})
  file(STRINGS "${CAPNP_PORT_PATCH}" patched_lines REGEX "^\\+\\+\\+ b/c\\+\\+/src/")
  set(patched_sources)
  foreach(line IN LISTS patched_lines)
    string(REGEX REPLACE "^\\+\\+\\+ b/c\\+\\+/src/" "" path "${line}")
    if(path MATCHES "\\.c\\+\\+$")
      if(NOT "${src}/${path}" IN_LIST all_sources)
        message(FATAL_ERROR "the port patch changes ${path}, which this build does not compile")
      endif()
      list(APPEND patched_sources "${src}/${path}")
    endif()
  endforeach()
  if(NOT patched_sources)
    message(FATAL_ERROR "no C++ translation unit found in ${CAPNP_PORT_PATCH}")
  endif()
  set_source_files_properties(${patched_sources} PROPERTIES COMPILE_OPTIONS "-Werror")
  message(STATUS "Port translation units compiled with -Werror: ${patched_sources}")
endif()

install(TARGETS capnp_tool capnpc_cpp capnpc_capnp RUNTIME DESTINATION .)
