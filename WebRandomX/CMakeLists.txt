# Builds randomx.wasm: the RandomX interpreter (no JIT - wasm cannot map
# executable pages) plus src/randomx_bridge.cpp, which exposes the rx_* C ABI
# web/randomx.js calls. Configure it with emcmake; see build.sh
# (POSIX) / build.ps1 (Windows) and README.md in this directory.
#
# The RandomX sources are compiled straight from a checkout instead of through
# RandomX's own CMakeLists: that build also produces randomx-tests/-benchmark
# (which want pthreads) and would pick the JIT source list. The list below is
# RandomX's portable list, the same one its CMake uses on architectures without
# a compiler backend; on wasm32 common.hpp sets RANDOMX_HAVE_COMPILER to 0, so
# vm_compiled.cpp falls back to JitCompilerFallback and nothing x86/ARM/RISC-V
# specific is compiled.
cmake_minimum_required(VERSION 3.13)
project(randomx-wasm C CXX)

set(RANDOMX_DIR "${CMAKE_CURRENT_SOURCE_DIR}/randomx" CACHE PATH
    "RandomX source checkout (build.sh clones it here)")

option(RX_FULL_MEM "Build the 2 GiB dataset (RANDOMX_FLAG_FULL_MEM) instead of light mode" OFF)
set(RX_MAX_MEMORY_MB "2147483648" CACHE STRING "wasm -sMAXIMUM_MEMORY (bytes)")

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "Configure through emcmake, e.g. emcmake cmake -S . -B build (see build.sh)")
endif()

if(NOT EXISTS "${RANDOMX_DIR}/src/randomx.cpp")
    message(FATAL_ERROR "RandomX sources not found in ${RANDOMX_DIR} - run build.sh / build.ps1 first")
endif()

# RandomX needs a small, wasm-only patch to be correct here: WebAssembly cannot
# change its floating point rounding mode, while RandomX's CFROUND instruction
# makes that mode part of consensus (src/randomx_wasm_fp.hpp implements it in
# software). build.sh / build.ps1 apply
# patches/randomx-wasm-soft-rounding.patch after cloning; refuse to build a
# module that would silently compute the wrong hashes instead.
file(READ "${RANDOMX_DIR}/src/intrin_portable.h" RX_INTRIN_PORTABLE)
string(FIND "${RX_INTRIN_PORTABLE}" "randomx_wasm_fp" RX_PATCH_POS)
if(RX_PATCH_POS EQUAL -1)
    message(FATAL_ERROR
        "The RandomX checkout in ${RANDOMX_DIR} is missing the wasm rounding patch. "
        "Run build.sh / build.ps1, which apply patches/randomx-wasm-soft-rounding.patch, "
        "or apply that patch by hand: without it the module cannot hash correctly.")
endif()

option(RX_FORCE_EXACT_FP
    "Debugging aid: make every wasm FP operation take the exact binary128 path (no error-free transforms)"
    OFF)

set(RX_SOURCES
    src/aes_hash.cpp
    src/argon2_ref.c
    src/argon2_ssse3.c
    src/argon2_avx2.c
    src/bytecode_machine.cpp
    src/cpu.cpp
    src/dataset.cpp
    src/soft_aes.cpp
    src/virtual_memory.c
    src/vm_interpreted.cpp
    src/allocator.cpp
    src/assembly_generator_x86.cpp
    src/instruction.cpp
    src/randomx.cpp
    src/superscalar.cpp
    src/vm_compiled.cpp
    src/vm_interpreted_light.cpp
    src/argon2_core.c
    src/blake2_generator.cpp
    src/instructions_portable.cpp
    src/reciprocal.c
    src/virtual_machine.cpp
    src/vm_compiled_light.cpp
    src/blake2/blake2b.c)

list(TRANSFORM RX_SOURCES PREPEND "${RANDOMX_DIR}/")

add_executable(randomx-wasm ${RX_SOURCES} src/randomx_bridge.cpp)
target_include_directories(randomx-wasm PRIVATE "${RANDOMX_DIR}/src" "${CMAKE_CURRENT_SOURCE_DIR}/src")

set_target_properties(randomx-wasm PROPERTIES
    OUTPUT_NAME randomx
    SUFFIX ".wasm"
    C_STANDARD 99
    C_STANDARD_REQUIRED ON
    CXX_STANDARD 11
    CXX_STANDARD_REQUIRED ON
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")

# -O3: this is mining code, hashing speed is the whole point.
# -fwasm-exceptions: RandomX uses try/catch around allocation (randomx.cpp), and
# emscripten's wasm exception handling needs no JS glue, unlike
# -sDISABLE_EXCEPTION_CATCHING=0 - which matters because the module is emitted
# standalone and instantiated straight from the .wasm bytes by randomx.js.
target_compile_options(randomx-wasm PRIVATE -O3 -fwasm-exceptions)
if(NOT RX_FULL_MEM)
    target_compile_definitions(randomx-wasm PRIVATE RX_FULL_MEM=0)
else()
    target_compile_definitions(randomx-wasm PRIVATE RX_FULL_MEM=1)
endif()
if(RX_FORCE_EXACT_FP)
    # Same module, but every r_i operation goes through binary128 - used to tell
    # an error-free-transform bug apart from an exact-path one (see
    # src/randomx_wasm_fp.hpp).
    target_compile_definitions(randomx-wasm PRIVATE RX_WASM_FP_FORCE_EXACT)
endif()

target_link_options(randomx-wasm PRIVATE
    -O3
    -fwasm-exceptions
    # Standalone reactor: no JS glue, no _start. randomx.js instantiates the
    # bytes directly, so it must call _initialize (the C++ static constructors,
    # e.g. RandomX's global Cpu object) itself - see wrapWasm().
    --no-entry
    -sSTANDALONE_WASM=1
    -sEXPORTED_FUNCTIONS=_rx_init,_rx_ready,_rx_version,_rx_alloc,_rx_free,_rx_cache_size,_rx_vm_size,_rx_hash
    -sEXPORTED_RUNTIME_METHODS=[]
    # A reactor with no _start never runs its C++ static constructors (RandomX
    # has a global Cpu object) until the embedder calls the initializer, and
    # wasm-ld may name it either _initialize (the WASI reactor convention) or
    # __wasm_call_ctors depending on the toolchain. randomx.js calls whichever
    # one is exported, so force whichever exists into the export list -
    # --export-if-defined, unlike --export, does not fail when absent (see the
    # wasm-ld docs). WebRandomX/verify_wasm.js fails the build if neither made it
    # out, since such a module cannot hash.
    -Wl,--export-if-defined=_initialize
    -Wl,--export-if-defined=__wasm_call_ctors
    # The 256 MiB cache cannot fit in the default 16 MiB, and it is allocated at
    # rx_init() time, so growth has to stay enabled. Initial size is deliberately
    # small: a page that never mines Monero should not reserve memory for it.
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=67108864
    -sMAXIMUM_MEMORY=${RX_MAX_MEMORY_MB}
    # RandomX's Argon2 fill and the interpreter frames are large; the default
    # 64 KiB stack overflows inside randomx_init_cache().
    -sSTACK_SIZE=5242880
    # A failed 256 MiB/2 GiB allocation must return NULL (rx_* reports it as
    # rc 3/4) instead of aborting the whole wasm instance.
    -sABORTING_MALLOC=0
    -sFILESYSTEM=0)

if(RX_FULL_MEM AND RX_MAX_MEMORY_MB LESS 3221225472)
    message(WARNING "RX_FULL_MEM needs ~2.3 GiB of wasm memory; raise RX_MAX_MEMORY_MB to 3221225472")
endif()
