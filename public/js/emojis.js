/* Slack-style emoji shortcodes (e.g. :smile:) → unicode.
   A pragmatic subset; extend as needed. Names follow Slack/GitHub conventions. */
window.EMOJI_MAP = {
  // smileys & people
  smile: '😄', smiley: '😃', grin: '😁', joy: '😂', rofl: '🤣', laughing: '😆',
  sweat_smile: '😅', wink: '😉', blush: '😊', innocent: '😇', heart_eyes: '😍',
  kissing_heart: '😘', yum: '😋', stuck_out_tongue: '😛', stuck_out_tongue_winking_eye: '😜',
  zany_face: '🤪', sunglasses: '😎', star_struck: '🤩', thinking_face: '🤔',
  raised_eyebrow: '🤨', neutral_face: '😐', expressionless: '😑', no_mouth: '😶',
  smirk: '😏', unamused: '😒', face_with_rolling_eyes: '🙄', grimacing: '😬',
  lying_face: '🤥', relieved: '😌', pensive: '😔', sleepy: '😪', drooling_face: '🤤',
  sleeping: '😴', mask: '😷', face_with_thermometer: '🤒', face_with_head_bandage: '🤕',
  nauseated_face: '🤢', sneezing_face: '🤧', hot_face: '🥵', cold_face: '🥶',
  woozy_face: '🥴', dizzy_face: '😵', exploding_head: '🤯', cowboy_hat_face: '🤠',
  partying_face: '🥳', smiling_face_with_tear: '🥲', sunglasses_cool: '😎',
  worried: '😟', frowning: '😦', anguished: '😧', open_mouth: '😮', astonished: '😲',
  flushed: '😳', pleading_face: '🥺', cry: '😢', sob: '😭', scream: '😱',
  confounded: '😖', persevere: '😣', disappointed: '😞', sweat: '😓', weary: '😩',
  tired_face: '😫', triumph: '😤', rage: '😡', angry: '😠', face_with_symbols_on_mouth: '🤬',
  smiling_imp: '😈', imp: '👿', skull: '💀', skull_and_crossbones: '☠️',
  poop: '💩', clown_face: '🤡', ghost: '👻', alien: '👽', robot: '🤖',
  // gestures
  wave: '👋', raised_hand: '✋', raised_back_of_hand: '🤚', vulcan_salute: '🖖',
  ok_hand: '👌', pinched_fingers: '🤌', pinching_hand: '🤏', v: '✌️',
  crossed_fingers: '🤞', love_you_gesture: '🤟', metal: '🤘', call_me_hand: '🤙',
  point_left: '👈', point_right: '👉', point_up_2: '👆', point_down: '👇',
  thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎',
  fist: '✊', facepunch: '👊', left_facing_fist: '🤛', right_facing_fist: '🤜',
  clap: '👏', raised_hands: '🙌', open_hands: '👐', handshake: '🤝',
  pray: '🙏', writing_hand: '✍️', muscle: '💪', mechanical_arm: '🦾',
  // hearts / objects
  heart: '❤️', orange_heart: '🧡', yellow_heart: '💛', green_heart: '💚',
  blue_heart: '💙', purple_heart: '💜', black_heart: '🖤', white_heart: '🤍',
  broken_heart: '💔', heart_eyes_cat: '😻', sparkling_heart: '💖',
  fire: '🔥', boom: '💥', sparkles: '✨', star: '⭐', star2: '🌟',
  zap: '⚡', sun_with_face: '🌞', moon: '🌜', rainbow: '🌈', cloud: '☁️',
  sunny: '☀️', umbrella: '☔', snowflake: '❄️', snowman: '⛄',
  // celebration
  tada: '🎉', confetti_ball: '🎊', balloon: '🎈', gift: '🎁', birthday: '🎂',
  trophy: '🏆', medal_sports: '🏅', '1st_place_medal': '🥇', crown: '👑',
  // tech / work
  computer: '💻', desktop_computer: '🖥️', keyboard: '⌨️', iphone: '📱',
  phone: '📞', email: '📧', envelope: '✉️', mailbox: '📬',
  printer: '🖨️', floppy_disk: '💾', cd: '💿', minidisc: '💽',
  battery: '🔋', electric_plug: '🔌', bulb: '💡', flashlight: '🔦',
  mag: '🔍', mag_right: '🔎', lock: '🔒', unlock: '🔓', key: '🔑',
  hammer: '🔨', wrench: '🔧', gear: '⚙️', nut_and_bolt: '🔩',
  link: '🔗', paperclip: '📎', scroll: '📜', page_facing_up: '📄',
  bookmark: '🔖', books: '📚', notebook: '📓', clipboard: '📋',
  chart_with_upwards_trend: '📈', chart_with_downwards_trend: '📉', bar_chart: '📊',
  // status / action
  white_check_mark: '✅', heavy_check_mark: '✔️', x: '❌', heavy_multiplication_x: '✖️',
  warning: '⚠️', no_entry: '⛔', no_entry_sign: '🚫', stop_sign: '🛑',
  exclamation: '❗', question: '❓', grey_exclamation: '❕', grey_question: '❔',
  arrow_right: '➡️', arrow_left: '⬅️', arrow_up: '⬆️', arrow_down: '⬇️',
  arrow_forward: '▶️', rewind: '⏪', fast_forward: '⏩',
  // food / random
  pizza: '🍕', hamburger: '🍔', taco: '🌮', burrito: '🌯', coffee: '☕',
  beer: '🍺', wine_glass: '🍷', tropical_drink: '🍹', cake: '🍰',
  doughnut: '🍩', cookie: '🍪', popcorn: '🍿',
  // nature / animals
  rocket: '🚀', alien_robot: '👾', boom_zap: '💥', radioactive: '☢️', biohazard: '☣️',
  shield: '🛡️', dart: '🎯', bug: '🐛', spider: '🕷️', snake: '🐍',
  // ctf-y
  detective: '🕵️', police_car: '🚓', siren: '🚨', oncoming_police_car: '🚔',
  pirate_flag: '🏴‍☠️', flag_white: '🏳️',
  // misc
  '100': '💯', eyes: '👀', speech_balloon: '💬', thought_balloon: '💭',
  zzz: '💤', hourglass: '⌛', hourglass_flowing_sand: '⏳', clock1: '🕐',
};

window.RECENT_EMOJIS = ['+1', 'tada', 'eyes', 'fire', '100', 'heart', 'rocket', 'white_check_mark', 'pray', 'thinking_face'];

window.replaceEmojiShortcodes = function (text) {
  return text.replace(/:([a-z0-9_+\-]+):/gi, (m, name) => {
    const e = window.EMOJI_MAP[name.toLowerCase()];
    return e || m;
  });
};
