#pragma once

#include <stdint.h>

void displayBegin();
void displayUpdate();
void displayShowBoot();
void displayShowStatus();
void displayShowButtonHold(unsigned long heldMs, const char* releaseAction, uint8_t progressPercent);
void displayClearButtonHold();
void displayShowButtonFeedback(const char* message);
