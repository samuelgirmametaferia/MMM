cmake_minimum_required(VERSION 3.21)

include(FetchContent)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

FetchContent_Declare(
  nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG v3.11.3
)

FetchContent_Declare(
  webview
  GIT_REPOSITORY https://github.com/webview/webview.git
  GIT_TAG 0.12.0
)

FetchContent_MakeAvailable(nlohmann_json webview)

add_executable(mmm_native
  src/main.cpp
)

target_link_libraries(mmm_native PRIVATE
  nlohmann_json::nlohmann_json
  webview::core
)

if(UNIX AND NOT APPLE)
  target_compile_definitions(mmm_native PRIVATE MMM_PLATFORM_LINUX=1)
endif()
