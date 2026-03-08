{ pkgs }: {
  deps = [
    pkgs.nodejs-20_x
    pkgs.nodePackages.npm
    pkgs.cmake
    pkgs.gnumake
    pkgs.gcc
    pkgs.python3
  ];
}
