cmake_minimum_required(VERSION 3.16)
project(photoprism-kiosk VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Enable automatic compilation of Qt files
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)
set(CMAKE_AUTOUIC ON)

find_package(Qt6 COMPONENTS 
    Core 
    Widgets 
    WebEngineWidgets 
    REQUIRED
)

add_executable(photoprism-kiosk
    src/main.cpp
    src/mainwindow.cpp
    src/configmanager.cpp
)

target_link_libraries(photoprism-kiosk PRIVATE
    Qt6::Core
    Qt6::Widgets
    Qt6::WebEngineWidgets
)

# Deployment step (optional, copies config to build dir for easy testing)
configure_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/../frontend/dist/config.json"
    "${CMAKE_CURRENT_BINARY_DIR}/config.json"
    COPYONLY
)
