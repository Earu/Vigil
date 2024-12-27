cmake_minimum_required(VERSION 3.10)
project(windows_hello)

# Set C++ standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Add library
add_library(windows_hello SHARED
    windows_hello.cpp
    windows_hello.h
)

# Windows specific settings
if(WIN32)
    target_link_libraries(windows_hello PRIVATE
        Credui.lib
        Advapi32.lib
    )
endif()